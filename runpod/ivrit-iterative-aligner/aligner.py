"""
Outer alignment loop with confusion-zone recovery.

Adapted from ivrit-ai/ivrit.ai's align_transcript_to_audio(), but designed for
raw text input (no VTT timestamps). Tracks position by counting consumed words
from the BreakableAligner output.

Flow:
  1. Try aligning remaining_text against audio from slice_start
  2. BreakableAligner breaks on confusion → partial result returned
  3. Keep successfully aligned words, skip forward, retry with remaining text
  4. Stitch all pieces together
"""

import stable_whisper
from stable_whisper.whisper_compatibility import SAMPLE_RATE
from tqdm import tqdm

from alignment.seekable_audio_loader import SeekableAudioLoader
from alignment.utils import (
    get_confusion_zone,
    get_text_from_segments,
    find_probable_segment_before_time,
)

PRE_CONFUSION_BACKWARD_WINDOW = 30
MAX_PRE_CONFUSION_RETRIES = 2
MIN_CONFUSION_SKIP = 15
MAX_CONFUSION_SKIP = 120
ZERO_DURATION_FAILURE_RATIO = 0.2
MAX_SKIP_ATTEMPTS = 20


def align_with_recovery(model, audio_path, text, language="yi",
                        trim_start=None, trim_end=None):
    """Align text to audio with confusion-zone detection and recovery.

    Returns:
        List of word dicts: [{ word, start, end, confidence }]
    """
    audio_file = str(audio_path)
    audio_metadata = stable_whisper.audio.utils.get_metadata(audio_file)
    audio_duration = audio_metadata.get("duration") or 0

    if not text.strip():
        return []

    slice_start = float(trim_start) if trim_start else 0.0
    if trim_end and float(trim_end) > 0:
        audio_duration = min(audio_duration, float(trim_end))
    to_align_next = text
    aligned_pieces = []
    skip_attempts = 0

    min_confusion_start = 0.0
    max_confusion_end = 0.0
    pre_confusion_tries = 0

    progress = tqdm(total=audio_duration, unit="sec", desc="Aligning")

    while to_align_next.strip() and skip_attempts < MAX_SKIP_ATTEMPTS:
        audio = SeekableAudioLoader(
            audio_file,
            sr=SAMPLE_RATE,
            stream=True,
            load_sections=[[slice_start, None]],
            test_first_chunk=False,
            buffer_size=300 * SAMPLE_RATE,
        )

        aligned = model.align(
            audio,
            to_align_next,
            language=language,
            failure_threshold=ZERO_DURATION_FAILURE_RATIO,
        )

        if aligned is None or not aligned.segments:
            slice_start += MIN_CONFUSION_SKIP
            remaining_audio = max(1, audio_duration - slice_start)
            text_fraction = MIN_CONFUSION_SKIP / remaining_audio
            chars_to_skip = max(50, int(len(to_align_next) * text_fraction))
            skip_pos = to_align_next.find(" ", chars_to_skip)
            if skip_pos == -1:
                break
            to_align_next = to_align_next[skip_pos:].strip()
            skip_attempts += 1
            progress.update(slice_start - progress.n)
            continue

        any_good = aligned.segments[0].start != aligned.segments[-1].end

        if not any_good:
            confusion_start = slice_start
            confusion_end = confusion_start + MIN_CONFUSION_SKIP
        else:
            confusion_start, confusion_end = get_confusion_zone(aligned)

        if confusion_start is None:
            aligned_pieces.extend(aligned.segments)
            progress.update(audio_duration - progress.n)
            break

        if confusion_start > max_confusion_end:
            min_confusion_start = confusion_start
            max_confusion_end = confusion_end
            pre_confusion_tries = 0
        else:
            min_confusion_start = min(min_confusion_start, confusion_start)
            max_confusion_end = max(max_confusion_end, confusion_end)

        probable_segment = find_probable_segment_before_time(
            aligned, confusion_start, PRE_CONFUSION_BACKWARD_WINDOW
        )

        if probable_segment is not None:
            segments_to_keep = aligned.segments[: probable_segment.id + 1]
            aligned_pieces.extend(segments_to_keep)

            slice_start = probable_segment.end
            progress.update(slice_start - progress.n)

            to_align_next = get_text_from_segments(
                aligned.segments[probable_segment.id + 1 :]
            )

            if pre_confusion_tries < MAX_PRE_CONFUSION_RETRIES:
                pre_confusion_tries += 1
                continue

        skip_attempts += 1
        pre_confusion_tries = 0

        max_confusion_end = max(
            max_confusion_end, min_confusion_start + MIN_CONFUSION_SKIP
        )
        max_confusion_end = min(
            min_confusion_start + MAX_CONFUSION_SKIP, max_confusion_end
        )

        progress.write(
            f"Skipping confusion zone: {min_confusion_start:.1f}s — {max_confusion_end:.1f}s"
        )

        if probable_segment is not None:
            skipped_segments = aligned.segments[probable_segment.id + 1 :]
        else:
            skipped_segments = aligned.segments

        if skipped_segments:
            skipped_text = get_text_from_segments(skipped_segments)

            top_aligned_ts = aligned_pieces[-1].end if aligned_pieces else 0
            skip_audio_start = max(top_aligned_ts, slice_start)
            skip_audio_end = max_confusion_end

            try:
                skip_audio = SeekableAudioLoader(
                    audio_file,
                    sr=SAMPLE_RATE,
                    stream=True,
                    load_sections=[[skip_audio_start, skip_audio_end]],
                    test_first_chunk=False,
                )
                skip_aligned = model.align(
                    skip_audio,
                    skipped_text,
                    language=language,
                    failure_threshold=ZERO_DURATION_FAILURE_RATIO,
                )
                if skip_aligned and skip_aligned.segments:
                    for seg in skip_aligned.segments:
                        for w in seg.words:
                            w.start = max(w.start, top_aligned_ts)
                            w.end = max(w.end, w.start)
                            w.end = min(w.end, skip_audio_end)
                            w.start = min(w.start, w.end)
                    aligned_pieces.extend(skip_aligned.segments)
            except Exception as e:
                progress.write(f"Skip alignment failed: {e}")

        slice_start = max_confusion_end
        progress.update(slice_start - progress.n)

        consumed_text = get_text_from_segments(aligned.segments)
        consumed_words = consumed_text.split()
        remaining_words = to_align_next.split()

        if len(consumed_words) < len(remaining_words):
            to_align_next = " ".join(remaining_words[len(consumed_words):])
        else:
            break

        min_confusion_start = 0
        max_confusion_end = 0

    progress.close()

    return _extract_words(aligned_pieces)


def _extract_words(segments):
    words = []
    for seg in segments:
        for w in seg.words:
            words.append({
                "word": w.word.strip(),
                "start": w.start,
                "end": w.end,
                "confidence": getattr(w, "probability", 0.0),
            })
    return words
