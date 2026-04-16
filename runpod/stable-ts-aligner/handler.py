"""
RunPod serverless handler for stable-ts alignment.

Accepts EITHER:
  { mode: "align", audio_url: "https://...", text: "...", language: "yi" }
  { mode: "align", audio_base64: "...", audio_format: ".mp3", text: "...", language: "yi" }

audio_url is preferred — the handler fetches the audio directly from R2/CDN,
avoiding Cloudflare Worker memory limits entirely.

Returns:
  { timestamps: [{ word, start, end, confidence }] }
"""

import base64
import os
import tempfile
import traceback
import urllib.request

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


def _resolve_audio(inp):
    """Resolve audio input to a temp file path. Accepts audio_url or audio_base64."""
    audio_url = inp.get("audio_url", "")
    audio_b64 = inp.get("audio_base64", "")
    audio_fmt = inp.get("audio_format", ".mp3")
    trim_start = inp.get("trim_start")
    trim_end = inp.get("trim_end")

    if not audio_url and not audio_b64:
        raise ValueError("Provide 'audio_url' or 'audio_base64'")

    suffix = audio_fmt if audio_fmt.startswith(".") else f".{audio_fmt}"

    if audio_url:
        # Detect format from URL
        url_path = audio_url.rsplit("?", 1)[0]
        if "." in url_path.split("/")[-1]:
            suffix = "." + url_path.split(".")[-1]

        print(f"[handler] Fetching audio from URL ({suffix})...")
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        urllib.request.urlretrieve(audio_url, tmp.name)
        tmp.close()
        print(f"[handler] Downloaded {os.path.getsize(tmp.name) / 1024 / 1024:.1f} MB")
    else:
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        tmp.write(base64.b64decode(audio_b64))
        tmp.close()

    return tmp.name, trim_start, trim_end


# ── Handler ──────────────────────────────────────────────────────────────────

def handler(job):
    """RunPod serverless handler function."""
    inp = job["input"]
    mode = inp.get("mode", "align")
    language = inp.get("language", "yi")
    text = inp.get("text", "")

    audio_path = None
    try:
        audio_path, trim_start, trim_end = _resolve_audio(inp)
        model = get_model()

        if mode == "transcribe":
            return _handle_transcribe(model, audio_path, language)
        else:
            return _handle_align(model, audio_path, text, language,
                                 trim_start=trim_start, trim_end=trim_end)

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
    """Forced alignment: align provided text to audio."""
    if not text.strip():
        return {"error": "Missing text for alignment"}

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
