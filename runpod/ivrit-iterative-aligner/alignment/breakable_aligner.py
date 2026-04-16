"""
BreakableAligner — extended from stable_whisper's Aligner with confusion detection.

Ported from ivrit-ai/ivrit.ai (MIT license).
Monitors a sliding window of word probabilities during alignment and breaks out
when the bad/good ratio exceeds a threshold, indicating a confusion zone.
"""

import warnings
from collections import deque
from typing import List, Optional, Union

import numpy as np
import torch
from stable_whisper.non_whisper.alignment import (
    Aligner,
    AudioLoader,
    BasicWordTiming,
    WhisperResult,
    WordToken,
    format_timestamp,
    safe_print,
    tqdm,
)

from alignment.utils import calculate_bad_good_prob_ratio


class BreakableAligner(Aligner):
    """Extended Aligner that breaks out when alignment confidence is too low."""

    def __init__(
        self,
        *args,
        confusion_window_duration: int = 120,
        confusion_warmup_duration: float = 10.0,
        good_seg_prob_threshold: float = 0.4,
        bad_to_good_ratio_threshold: float = 0.8,
        max_time_without_committed_words: float = 60.0,
        **kwargs,
    ):
        self.confusion_window_duration = confusion_window_duration
        self.confusion_warmup_duration = confusion_warmup_duration
        self.good_seg_prob_threshold = good_seg_prob_threshold
        self.bad_to_good_ratio_threshold = bad_to_good_ratio_threshold
        self.max_time_without_committed_words = max_time_without_committed_words
        super().__init__(*args, **kwargs)

    def _update_pbar(self, tqdm_pbar, last_ts, bad_good_ratio=None, avg_prob=None, finish=False):
        postfix = {}
        if bad_good_ratio is not None:
            postfix["err_ratio"] = round(bad_good_ratio, 2)
        if avg_prob is not None:
            postfix["avg_prob"] = round(avg_prob, 2)
        if postfix:
            tqdm_pbar.set_postfix(postfix)
        super()._update_pbar(tqdm_pbar, last_ts, finish)

    def update_word_prob_window(self, window_words, total_word_duration, new_words, current_time):
        for word in new_words:
            window_words.append(word)
            total_word_duration += max(0.1, word.end - word.start)

        window_start_time = current_time - self.confusion_window_duration
        while window_words and window_words[0].end < window_start_time:
            old_word = window_words.popleft()
            total_word_duration -= max(0.1, old_word.end - old_word.start)

        bad_good_ratio = None
        avg_probability = None
        if total_word_duration >= self.confusion_warmup_duration and window_words:
            bad_good_ratio, _, _ = calculate_bad_good_prob_ratio(
                window_words, self.good_seg_prob_threshold
            )
            probabilities = [word.probability for word in window_words]
            avg_probability = np.mean(probabilities) if probabilities else None

        return window_words, total_word_duration, bad_good_ratio, avg_probability

    def align(
        self,
        audio: Union[str, np.ndarray, torch.Tensor, bytes, AudioLoader],
        text: Union[str, List[int], WhisperResult],
        **options,
    ) -> Union[WhisperResult, None]:
        self._reset()
        self._load_text(text)
        self._load_audio(audio)
        self._load_nonspeech_detector()
        for k in list(options.keys()):
            if hasattr(self, k):
                setattr(self, k, options.pop(k))
        self.options.update(options)

        with tqdm(
            total=self._initial_duration,
            unit="sec",
            disable=self.options.progress.verbose is not False,
            desc="Align",
        ) as tqdm_pbar:
            result: List[BasicWordTiming] = []
            last_ts = 0.0
            premature_stop = False

            window_words = deque()
            total_word_duration = 0.0
            current_bad_good_ratio = None
            current_avg_prob = None
            last_committed_words_ts = None

            while self._all_word_tokens:
                audio_segment, seek = self.audio_loader.next_valid_chunk(
                    self._seek_sample, self.n_samples
                )
                self._seek_sample = seek
                self._time_offset = self._seek_sample / self.sample_rate
                if audio_segment is None:
                    break

                self._nonspeech_preds = self.nonspeech_predictor.predict(
                    audio=audio_segment, offset=self._time_offset
                )

                audio_segment = self._skip_nonspeech(audio_segment)
                if audio_segment is None:
                    continue

                self._curr_words = self._compute_timestamps(
                    audio_segment, *self._get_curr_words()
                )
                self._seg_word_tokens = [
                    WordToken(wts.word, wts.tokens) for wts in self._curr_words
                ]

                last_ts = self._fallback(audio_segment.shape[-1])

                if self._curr_words:
                    (
                        window_words,
                        total_word_duration,
                        current_bad_good_ratio,
                        current_avg_prob,
                    ) = self.update_word_prob_window(
                        window_words, total_word_duration, self._curr_words, last_ts
                    )
                    last_committed_words_ts = last_ts
                elif last_committed_words_ts is None:
                    last_committed_words_ts = last_ts

                self._update_pbar(
                    tqdm_pbar, last_ts, current_bad_good_ratio, current_avg_prob
                )
                result.extend(self._curr_words)

                if self.options.progress.verbose:
                    line = "\n".join(
                        f"[{format_timestamp(wts.start)}] -> "
                        f'[{format_timestamp(wts.end)}] "{wts.word}"'
                        for wts in self._curr_words
                    )
                    safe_print(line)

                if self.failure_threshold is not None:
                    self.failure_count += sum(
                        1 for wts in self._curr_words if wts.end - wts.start == 0
                    )
                    if self.failure_count > self.max_fail:
                        premature_stop = True
                        tqdm_pbar.write("Breaking — too many zero-duration segments")
                        break

                if (
                    current_bad_good_ratio is not None
                    and current_bad_good_ratio > self.bad_to_good_ratio_threshold
                ):
                    premature_stop = True
                    tqdm_pbar.write(
                        f"Breaking — bad/good ratio {current_bad_good_ratio:.2f}"
                    )
                    break

                if (
                    last_ts - last_committed_words_ts
                    > self.max_time_without_committed_words
                ):
                    premature_stop = True
                    tqdm_pbar.write("Breaking — no committed words for too long")
                    break

            self._update_pbar(
                tqdm_pbar,
                last_ts,
                current_bad_good_ratio,
                current_avg_prob,
                self.failure_count <= self.max_fail,
            )

        if not premature_stop and self._temp_data.word is not None:
            result.append(self._temp_data.word)

        if not result and self.options.progress.verbose:
            warnings.warn("Failed to align text.", stacklevel=2)

        if self._all_word_tokens and not self.remove_instant_words:
            final_total_duration = self.audio_loader.get_duration(3)
            result.extend(
                [
                    BasicWordTiming(
                        word=w.word,
                        start=final_total_duration,
                        end=final_total_duration,
                        tokens=w.tokens,
                        probability=0.0,
                    )
                    for w in self._all_word_tokens
                ]
            )

        self.audio_loader.terminate()
        self.nonspeech_predictor.finalize_timings()

        if not result:
            return None

        final_result = [
            dict(
                word=w.word,
                start=w.start,
                end=w.end,
                tokens=w.tokens,
                probability=w.probability,
            )
            for w in result
        ]
        if len(self._split_indices_by_char):
            word_lens = np.cumsum([len(w.word) for w in result])
            split_indices = [
                np.flatnonzero(word_lens >= i)[0] + 1
                for i in self._split_indices_by_char
            ]
            final_result = WhisperResult(
                [
                    final_result[i:j]
                    for i, j in zip([0] + split_indices[:-1], split_indices)
                    if i != j
                ]
            )
        else:
            final_result = WhisperResult([final_result])

        self._suppress_silence(final_result)

        if not self.original_split:
            final_result.regroup(self.options.post.regroup)

        return final_result


def breakable_align(
    model,
    audio: Union[str, np.ndarray, torch.Tensor, bytes, AudioLoader],
    text: Union[str, List[int], WhisperResult],
    language: str = None,
    *,
    tokenizer=None,
    ignore_compatibility: bool = False,
    remove_instant_words: bool = False,
    token_step: int = 100,
    original_split: bool = False,
    word_dur_factor: Optional[float] = 2.0,
    max_word_dur: Optional[float] = 3.0,
    nonspeech_skip: Optional[float] = 5.0,
    fast_mode: bool = False,
    failure_threshold: Optional[float] = None,
    confusion_window_duration: int = 120,
    confusion_warmup_duration: float = 10.0,
    good_seg_prob_threshold: float = 0.4,
    bad_to_good_ratio_threshold: float = 0.8,
    max_time_without_committed_words: float = 60.0,
    **options,
) -> Union[WhisperResult, None]:
    """Align text to audio with confusion-aware breakout."""
    is_faster_model = model.__module__.startswith("faster_whisper.")
    if not is_faster_model:
        from stable_whisper.whisper_compatibility import warn_compatibility_issues, whisper
        warn_compatibility_issues(whisper, ignore_compatibility)

    from stable_whisper.whisper_compatibility import N_SAMPLES, SAMPLE_RATE, TOKENS_PER_SECOND
    from stable_whisper.alignment import (
        get_alignment_tokenizer,
        get_whisper_alignment_func,
        set_result_language,
    )
    from stable_whisper.options import AllOptions

    max_token_step = (
        model.max_length if is_faster_model else model.dims.n_text_ctx
    ) - 6
    if token_step < 1:
        token_step = max_token_step
    elif token_step > max_token_step:
        raise ValueError(
            f"Max token_step is {max_token_step} but got {token_step}."
        )

    tokenizer, supported_languages = get_alignment_tokenizer(
        model, is_faster_model, text, language, tokenizer
    )

    options_obj = AllOptions(options, vanilla_align=not is_faster_model)
    split_words_by_space = getattr(
        tokenizer, "language_code", tokenizer.language
    ) not in {"zh", "ja", "th", "lo", "my"}
    model_type = "fw" if is_faster_model else None
    inference_func = get_whisper_alignment_func(
        model, tokenizer, model_type, options_obj
    )

    aligner = BreakableAligner(
        inference_func=inference_func,
        decode=tokenizer.decode,
        encode=tokenizer.encode,
        split_words_by_space=split_words_by_space,
        sample_rate=SAMPLE_RATE,
        tokens_per_sec=TOKENS_PER_SECOND,
        max_segment_length=N_SAMPLES,
        remove_instant_words=remove_instant_words,
        token_step=token_step,
        original_split=original_split,
        word_dur_factor=word_dur_factor,
        max_word_dur=max_word_dur,
        nonspeech_skip=nonspeech_skip,
        fast_mode=fast_mode,
        failure_threshold=failure_threshold,
        confusion_window_duration=confusion_window_duration,
        confusion_warmup_duration=confusion_warmup_duration,
        good_seg_prob_threshold=good_seg_prob_threshold,
        bad_to_good_ratio_threshold=bad_to_good_ratio_threshold,
        max_time_without_committed_words=max_time_without_committed_words,
        all_options=options_obj,
    )

    result = aligner.align(audio, text)
    set_result_language(result, tokenizer, language, supported_languages)

    return result
