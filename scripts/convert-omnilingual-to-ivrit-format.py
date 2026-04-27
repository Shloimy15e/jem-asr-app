"""Convert facebook/omnilingual-asr-corpus (ydd_Hebr) to ivrit-ai's training schema.

ivrit-ai's train-whisper.py expects a `transcript` column (preprocess/preperator.py
raises ValueError if missing). Omnilingual provides `raw_text`, plus a few other
columns that ivrit-ai's preparator ignores. We rename, clean, drop, then push to
HF Hub so the trainer can consume it identically to the two ivrit-ai datasets.

Cleaning steps:
  1. Strip `<hesitation>` markup (Whisper would learn to emit the literal token).
  2. Strip lone surrogate / U+FFFD replacement chars (encoding artifacts in the
     source — same problem JEM transcripts had; Safari throws on these at
     JSON.stringify time during alignment).

Output schema matches ivrit-ai/crowd-recital-yi-whisper-training:
  - audio:           Audio (16kHz)
  - transcript:      string (no timestamps — has_timestamps=False)
  - has_prev:        bool   (always False — omnilingual has no prev-utterance link)
  - has_timestamps:  bool   (always False)
  - prev_transcript: string (always '')
  - metadata:        dict   {seek: 0.0, source: 'omnilingual', entry_id: '<spk>_<seg>'}

Usage:
    pip install datasets huggingface_hub
    huggingface-cli login   # needs write access to TARGET_REPO
    python scripts/convert-omnilingual-to-ivrit-format.py \\
        --target-repo ABE101/omnilingual-ydd-Hebr-ivrit-format \\
        [--dry-run]
"""

import argparse
import re

from datasets import Audio, DatasetDict, Features, Value, load_dataset

SOURCE_DATASET = "facebook/omnilingual-asr-corpus"
SOURCE_CONFIG = "ydd_Hebr"
SOURCE_SPLITS = ("train", "dev", "test")
SAMPLE_RATE = 16_000

# Markup tags Omnilingual transcribers used. Whisper does not naturally emit
# these — leaving them in trains the model to hallucinate the literal token.
MARKUP_RE = re.compile(r"<\s*hesitation\s*>", re.IGNORECASE)

# Lone surrogates and the U+FFFD replacement char — same fix as alignment.js.
BAD_CHARS_RE = re.compile(r"[\ud800-\udfff�]")


def clean_transcript(text: str) -> str:
    if not text:
        return ""
    text = MARKUP_RE.sub("", text)
    text = BAD_CHARS_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def to_ivrit_row(example: dict) -> dict:
    return {
        "audio": example["audio"],
        "transcript": clean_transcript(example.get("raw_text") or ""),
        "has_prev": False,
        "has_timestamps": False,
        "prev_transcript": "",
        "metadata": {
            "seek": 0.0,
            "source": "omnilingual",
            "entry_id": f"{example.get('speaker_id', 'unk')}_{example.get('segment_id', 'unk')}",
        },
    }


TARGET_FEATURES = Features({
    "audio": Audio(sampling_rate=SAMPLE_RATE),
    "transcript": Value("string"),
    "has_prev": Value("bool"),
    "has_timestamps": Value("bool"),
    "prev_transcript": Value("string"),
    "metadata": {
        "seek": Value("float64"),
        "source": Value("string"),
        "entry_id": Value("string"),
    },
})


def convert_split(split_name: str):
    print(f"  loading {SOURCE_DATASET}:{SOURCE_CONFIG}:{split_name} …")
    ds = load_dataset(SOURCE_DATASET, SOURCE_CONFIG, split=split_name)
    ds = ds.cast_column("audio", Audio(sampling_rate=SAMPLE_RATE))
    columns_to_remove = [c for c in ds.column_names if c not in {"audio", "raw_text", "speaker_id", "segment_id"}]
    converted = ds.map(
        to_ivrit_row,
        remove_columns=ds.column_names,
        features=TARGET_FEATURES,
        desc=f"converting {split_name}",
    )
    # Drop empty transcripts (cleaning may have stripped a row to nothing).
    before = len(converted)
    converted = converted.filter(lambda x: bool(x["transcript"]))
    dropped = before - len(converted)
    if dropped:
        print(f"    dropped {dropped} rows with empty transcript after cleaning")
    print(f"    {len(converted)} rows in {split_name}")
    return converted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-repo", required=True, help="HF Hub repo to push to, e.g. ABE101/omnilingual-ydd-Hebr-ivrit-format")
    parser.add_argument("--dry-run", action="store_true", help="Convert in memory; skip the HF push")
    parser.add_argument("--private", action="store_true", help="Push as private repo")
    args = parser.parse_args()

    print(f"── Convert omnilingual ydd_Hebr → ivrit-ai schema ──────────────")
    print(f"Source: {SOURCE_DATASET}:{SOURCE_CONFIG}")
    print(f"Target: {args.target_repo}{' (dry-run)' if args.dry_run else ''}\n")

    splits = {name: convert_split(name) for name in SOURCE_SPLITS}
    dataset = DatasetDict(splits)

    print(f"\n── Summary ─────────────────────────────────────────────────────")
    for name, ds in splits.items():
        print(f"  {name}: {len(ds)} rows")

    if args.dry_run:
        sample = splits["train"][0]
        print("\n  dry-run: sample row keys:", list(sample.keys()))
        print(f"  transcript[:80]: {sample['transcript'][:80]!r}")
        return

    print(f"\nPushing to {args.target_repo} …")
    dataset.push_to_hub(args.target_repo, private=args.private)
    print("Done.")


if __name__ == "__main__":
    main()
