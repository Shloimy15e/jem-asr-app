"""
Utility functions for the BreakableAligner and outer alignment loop.

Ported from ivrit-ai/ivrit.ai (MIT license).
"""

from collections import deque
from types import MethodType

import numpy as np
import stable_whisper


def calculate_bad_good_prob_ratio(words, good_seg_prob_threshold=0.4):
    """Calculate ratio of bad-to-good word durations based on probability.

    Returns:
        (ratio, total_bad_duration, total_good_duration)
        ratio is inf when there are no good words.
    """
    bad_durations = [
        max(0.1, w.end - w.start)
        for w in words
        if w.probability < good_seg_prob_threshold
    ]
    good_durations = [
        w.end - w.start for w in words if w.probability >= good_seg_prob_threshold
    ]

    total_bad = sum(bad_durations)
    total_good = sum(good_durations)

    ratio = float("inf") if total_good == 0 else (total_bad / total_good)
    return ratio, total_bad, total_good


def get_confusion_zone(
    aligned,
    detection_window_duration=120,
    hop_length=30,
    good_seg_prob_threshold=0.4,
    bad_to_good_probs_detection_threshold=0.8,
):
    """Detect a confusion zone in the alignment using a sliding window.

    Returns:
        (start_time, end_time) of the confusion zone, or (None, None) if clean.
    """
    all_words = aligned.all_words()
    if not all_words:
        return None, None

    start_time = all_words[0].start
    end_time = all_words[-1].end

    window_start = start_time
    window_end = window_start + detection_window_duration
    window_words = deque()
    word_index = 0

    while window_end < end_time:
        while word_index < len(all_words) and all_words[word_index].start < window_end:
            word = all_words[word_index]
            if word.end > window_start:
                window_words.append(word)
            word_index += 1

        while window_words and window_words[0].end <= window_start:
            window_words.popleft()

        ratio, _, _ = calculate_bad_good_prob_ratio(
            window_words, good_seg_prob_threshold
        )

        if ratio > bad_to_good_probs_detection_threshold:
            return window_start, window_end

        window_start += hop_length
        window_end = window_start + detection_window_duration

    return None, None


def create_transcript_from_segments(segments):
    """Create a WhisperResult from a list of segments."""
    segments_as_dict = [s.to_dict() for s in segments]
    return stable_whisper.WhisperResult({"segments": segments_as_dict})


def get_text_from_segments(segments):
    """Concatenate text from a list of segments."""
    return "".join(s.text for s in segments)


def find_probable_segment_before_time(
    aligned,
    find_before_time,
    go_back_duration,
    minimal_seg_prob=0.8,
    max_backward_hops=6,
):
    """Find a high-confidence segment before a given time.

    Useful for finding a reliable restart point before a confusion zone.

    Returns:
        A Segment object, or None if no suitable segment found.
    """
    segment_to_start_after = None
    search_start = find_before_time - go_back_duration

    while not segment_to_start_after and max_backward_hops > 0:
        pre_segments = aligned.get_content_by_time(
            (search_start, search_start + go_back_duration),
            segment_level=True,
        )
        if pre_segments:
            for seg in pre_segments:
                probs = [w.probability for w in seg.words]
                avg_prob = np.mean(probs) if probs else 0
                if avg_prob >= minimal_seg_prob:
                    segment_to_start_after = seg
                    break

        if not segment_to_start_after:
            max_backward_hops -= 1
            search_start -= go_back_duration
            if search_start < 0:
                break

    return segment_to_start_after


def get_breakable_align_model(model_name, device="cuda", compute_type="float16"):
    """Load a faster-whisper model with the breakable_align method attached.

    Args:
        model_name: HuggingFace model ID or local path.
        device: "cpu", "cuda", or "auto". Can include index: "cuda:0".
        compute_type: "int8", "float16", "float32".

    Returns:
        A faster-whisper model with model.align = breakable_align.
    """
    from alignment.breakable_aligner import breakable_align

    device_index = 0
    if len(device.split(":")) == 2:
        device, device_index = device.split(":")
        device_index = int(device_index)

    model = stable_whisper.load_faster_whisper(
        model_name,
        device=device,
        device_index=device_index,
        compute_type=compute_type,
    )
    model.align = MethodType(breakable_align, model)

    return model
