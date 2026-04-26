"""
Verify Stage 2 timestamp integrity — does every word in the parquet dataset
correspond to the same word at the same (absolute) time in Stage 1's JSON?

Stage 2 packs phrase segments into 30s slices and rewrites word timestamps
from absolute-in-original-audio → relative-to-slice-start. The `seek` field
on each slice tells us the slice's origin in the source audio. So:

    absolute_time_from_parquet = row['metadata']['seek'] + relative_timestamp

…should equal the word's `start` / `end` in the Stage 1 JSON, modulo
Whisper's 0.02s timestamp quantization.

Run from the repo root:

    vendor/asr-training/.venv/Scripts/python scripts/verify-timestamps.py \\
        --parquet dist-training/parquet/jemedia \\
        --stage1  dist-training/jemedia

Exit code:
    0 = all checks passed
    1 = at least one mismatch found (details printed)
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

from datasets import load_from_disk

# Whisper timestamps quantize to 0.02s increments.
# Allow 1 step of error in either direction (worst case from combined
# ceil/floor rounding on both `seek` and the timestamp token itself).
TS_TOLERANCE = 0.04

# Parse transcript strings like:
#   <|0.14|> word word word<|12.40|><|12.98|> more<|18.12|>...
# into a list of (start, end, text) tuples.
SEG_RE = re.compile(r"<\|(\d+\.\d{2})\|>([^<]*?)<\|(\d+\.\d{2})\|>")


def parse_transcript(text):
    out = []
    for m in SEG_RE.finditer(text):
        start = float(m.group(1))
        seg_text = m.group(2)
        end = float(m.group(3))
        out.append((start, seg_text, end))
    return out


def load_stage1_alignments(stage1_root):
    """entry_id → list of {start, end, text, words:[{word,start,end},...]}."""
    out = {}
    root = Path(stage1_root)
    for p in root.rglob("transcript.aligned.json"):
        entry_id = p.parent.name
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        out[entry_id] = data.get("segments", [])
    return out


def verify(parquet_dir, stage1_root, sample_rows=None, verbose=False):
    ds = load_from_disk(parquet_dir)
    stage1 = load_stage1_alignments(stage1_root)

    rows = range(ds.num_rows)
    if sample_rows:
        rows = list(rows)[:sample_rows]

    total_segments = 0
    total_mismatches = 0
    slice_issues = 0
    issue_examples = []

    for i in rows:
        row = ds[i]
        entry_id = row["metadata"]["entry_id"]
        seek = float(row["metadata"]["seek"])
        slice_segments = parse_transcript(row["transcript"])

        # Pull the Stage 1 segments for this entry
        src_segments = stage1.get(entry_id)
        if src_segments is None:
            print(f"  row {i} {entry_id}: no Stage 1 JSON found", flush=True)
            slice_issues += 1
            continue

        # Flatten stage 1 to {start: (end, first-few-words)} keyed by start
        src_by_start = {round(s["start"], 2): s for s in src_segments}

        for (rel_start, seg_text, rel_end) in slice_segments:
            abs_start = round(seek + rel_start, 2)
            abs_end = round(seek + rel_end, 2)
            total_segments += 1

            # Find the nearest Stage 1 segment by start time
            nearest_start = min(src_by_start.keys(),
                                key=lambda s: abs(s - abs_start))
            drift = abs(nearest_start - abs_start)

            if drift > TS_TOLERANCE:
                total_mismatches += 1
                if len(issue_examples) < 10:
                    issue_examples.append({
                        "row": i,
                        "entry_id": entry_id,
                        "seek": seek,
                        "rel_start": rel_start,
                        "abs_start_from_parquet": abs_start,
                        "nearest_stage1_start": nearest_start,
                        "drift_seconds": round(drift, 3),
                        "parquet_text": seg_text.strip()[:60],
                        "stage1_text": src_by_start[nearest_start]["text"][:60],
                    })

            if verbose:
                src = src_by_start.get(nearest_start, {})
                print(f"  row {i} entry={entry_id} seek={seek:7.2f} "
                      f"rel=[{rel_start:5.2f}-{rel_end:5.2f}] "
                      f"abs=[{abs_start:7.2f}-{abs_end:7.2f}] "
                      f"drift={drift:.3f}s   '{seg_text.strip()[:40]}'",
                      flush=True)

    # ── Audio duration check ─────────────────────────────────────────────
    # Non-final slices per-entry must be exactly 30s @ 16kHz. The LAST slice
    # of each source audio can be shorter (remainder of the source audio).
    expected_samples = 30 * 16000
    duration_issues = []
    # Index the last row per entry_id (within the rows we're checking)
    last_row_for_entry = {}
    for i in rows:
        last_row_for_entry[ds[i]["metadata"]["entry_id"]] = i

    for i in rows:
        row = ds[i]
        audio = row["audio"]["array"]
        actual = len(audio)
        sr = row["audio"]["sampling_rate"]
        if sr != 16000:
            duration_issues.append(f"row {i}: sample rate {sr} ≠ 16000")
        is_last_for_entry = (i == last_row_for_entry[row["metadata"]["entry_id"]])
        if not is_last_for_entry and actual != expected_samples:
            duration_issues.append(
                f"row {i}: {actual} samples ≠ {expected_samples} (30s @ 16kHz)"
            )

    # ── Report ───────────────────────────────────────────────────────────
    print()
    print("── Timestamp integrity report ─────────────────────────────")
    print(f"Parquet rows checked:  {len(list(rows))} / {ds.num_rows}")
    print(f"Total segments:        {total_segments}")
    print(f"Segments with drift > {TS_TOLERANCE}s:  {total_mismatches}")
    print(f"Slice-level issues:    {slice_issues}")
    print(f"Audio duration issues: {len(duration_issues)}")

    if issue_examples:
        print()
        print("Sample mismatches (up to 10):")
        for e in issue_examples:
            print(f"  row {e['row']} entry={e['entry_id']} "
                  f"drift={e['drift_seconds']}s")
            print(f"    parquet: abs_start={e['abs_start_from_parquet']}   "
                  f"'{e['parquet_text']}'")
            print(f"    stage1:  start    ={e['nearest_stage1_start']}   "
                  f"'{e['stage1_text']}'")

    if duration_issues:
        print()
        print("Audio duration issues:")
        for msg in duration_issues[:5]:
            print(f"  {msg}")

    failed = total_mismatches > 0 or slice_issues > 0 or duration_issues
    print()
    print("✓ PASS" if not failed else "✗ FAIL")
    return 0 if not failed else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True, help="Stage 2 dataset dir")
    ap.add_argument("--stage1", required=True,
                    help="Stage 1 root (contains <audio_id>/transcript.aligned.json)")
    ap.add_argument("--sample", type=int, default=None,
                    help="Only check first N rows (default: all)")
    ap.add_argument("--verbose", action="store_true",
                    help="Print every segment check")
    args = ap.parse_args()
    sys.exit(verify(args.parquet, args.stage1,
                    sample_rows=args.sample, verbose=args.verbose))
