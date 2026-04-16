"""
RunPod serverless handler for stable-ts alignment.

Accepts the same request format as the existing Whisper alignment endpoint:
  { mode: "align", audio_base64: "...", audio_format: ".mp3", text: "...", language: "yi" }

Returns:
  { timestamps: [{ word: "...", start: 0.5, end: 0.8, confidence: 0.95 }] }
"""

import base64
import os
import tempfile
import traceback

import runpod
import stable_whisper

from alignment.utils import get_breakable_align_model
from aligner import align_with_recovery

# ── Model (loaded once, reused across warm invocations) ──────────────────────
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


# ── Handler ──────────────────────────────────────────────────────────────────

def handler(job):
    """RunPod serverless handler function."""
    inp = job["input"]
    mode = inp.get("mode", "align")
    language = inp.get("language", "yi")
    text = inp.get("text", "")
    audio_b64 = inp.get("audio_base64", "")
    audio_fmt = inp.get("audio_format", ".mp3")

    if not audio_b64:
        return {"error": "Missing audio_base64"}

    # Write audio to a temp file
    suffix = audio_fmt if audio_fmt.startswith(".") else f".{audio_fmt}"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(base64.b64decode(audio_b64))
        tmp.close()
        audio_path = tmp.name

        model = get_model()

        if mode == "transcribe":
            return _handle_transcribe(model, audio_path, language)
        else:
            return _handle_align(model, audio_path, text, language)

    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _handle_align(model, audio_path, text, language):
    """Forced alignment: align provided text to audio."""
    if not text.strip():
        return {"error": "Missing text for alignment"}

    words = align_with_recovery(model, audio_path, text, language)

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
        "provider": "stable-ts",
    }


def _handle_transcribe(model, audio_path, language):
    """Pure transcription (no reference text)."""
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
    full_text = " ".join(seg.text.strip() for seg in result.segments)
    return {"text": full_text, "segments": segments}


# ── Entry point ──────────────────────────────────────────────────────────────

runpod.serverless.start({"handler": handler})
