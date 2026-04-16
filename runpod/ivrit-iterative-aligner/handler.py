"""
RunPod serverless handler for the ivrit-ai iterative Yiddish aligner.

Input:
    {
      "audio_url": "https://<public-r2-url>/file.mp3",   # required
      "text": "...",                                      # required for align mode
      "mode": "align" | "transcribe",                     # default "align"
      "language": "yi",                                   # default "yi"
      "trim_start": 0.0,                                  # optional, seconds
      "trim_end": 120.0                                   # optional, seconds
    }

The audio is always downloaded to the pod's local disk BEFORE alignment starts
(see download_audio.download_to_vm). This avoids any streaming/network stalls
mid-alignment on long audio.

Output (align):
    {
      "timestamps": [{word, start, end, confidence}, ...],
      "avg_confidence": float,
      "low_confidence_count": int,
      "audio_duration": float,
      "provider": "ivrit-iterative"
    }
"""

import os
import traceback

import runpod

from aligner import align_with_recovery
from alignment.utils import get_breakable_align_model
from download_audio import download_to_vm

MODEL_NAME = os.environ.get("MODEL_NAME", "ivrit-ai/yi-whisper-large-v3-turbo-ct2")
DEVICE = os.environ.get("DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "float16")

_model = None


def get_model():
    global _model
    if _model is None:
        print(f"[handler] Loading model {MODEL_NAME} on {DEVICE} ({COMPUTE_TYPE})...")
        _model = get_breakable_align_model(MODEL_NAME, DEVICE, COMPUTE_TYPE)
        print("[handler] Model loaded.")
    return _model


def handler(job):
    inp = job.get("input") or {}
    mode = inp.get("mode", "align")
    language = inp.get("language", "yi")
    text = inp.get("text", "") or ""
    audio_url = inp.get("audio_url", "") or ""
    trim_start = inp.get("trim_start")
    trim_end = inp.get("trim_end")

    if not audio_url:
        return {"error": "Missing required 'audio_url'"}
    if mode == "align" and not text.strip():
        return {"error": "Missing required 'text' for align mode"}

    audio_path = None
    try:
        audio_path, duration = download_to_vm(audio_url)
        model = get_model()

        if mode == "transcribe":
            result = _handle_transcribe(model, audio_path, language)
        else:
            result = _handle_align(model, audio_path, text, language,
                                   trim_start=trim_start, trim_end=trim_end)

        result["audio_duration"] = round(duration, 3)
        return result

    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}
    finally:
        if audio_path:
            try:
                os.unlink(audio_path)
            except OSError:
                pass


def _handle_align(model, audio_path, text, language, trim_start=None, trim_end=None):
    words = align_with_recovery(model, audio_path, text, language,
                                trim_start=trim_start, trim_end=trim_end)
    timestamps = [
        {
            "word": w["word"],
            "start": round(w["start"], 3),
            "end": round(w["end"], 3),
            "confidence": round(w["confidence"], 4),
        }
        for w in words
    ]
    avg_conf = sum(t["confidence"] for t in timestamps) / max(len(timestamps), 1)
    low_count = sum(1 for t in timestamps if t["confidence"] < 0.4)
    return {
        "timestamps": timestamps,
        "avg_confidence": round(avg_conf, 4),
        "low_confidence_count": low_count,
        "provider": "ivrit-iterative",
    }


def _handle_transcribe(model, audio_path, language):
    result = model.transcribe(audio_path, language=language)
    segments = []
    for seg in result.segments:
        segments.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text,
            "words": [
                {
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 4),
                }
                for w in seg.words
            ],
        })
    full_text = " ".join(s.text.strip() for s in result.segments)
    return {"text": full_text, "segments": segments, "provider": "ivrit-iterative"}


runpod.serverless.start({"handler": handler})
