"""
RunPod serverless handler for stable-ts alignment (trim-capable variant).

Accepts EITHER:
  { mode: "align", audio_url: "https://...", text: "...", language: "yi",
    trim_start?: <sec>, trim_end?: <sec> }
  { mode: "align", audio_base64: "...", audio_format: ".mp3", text: "...",
    language: "yi", trim_start?: <sec>, trim_end?: <sec> }

audio_url is preferred — the handler fetches the audio directly from R2/CDN,
avoiding Cloudflare Worker memory limits entirely.

When trim_start / trim_end are provided, the audio is pre-trimmed with
ffmpeg before alignment. The aligner sees a file that already starts at 0,
so returned timestamps are relative to the trim window; callers shift them
back to absolute time by adding trim_start.

Returns:
  { timestamps: [{ word, start, end, confidence }] }
"""

import base64
import os
import subprocess
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


def _trim_audio(src_path, suffix, trim_start, trim_end):
    """ffmpeg-trim src_path into a new temp file and return its path.

    SeekableAudioLoader only honours trim_start (via ffmpeg -ss); it has no
    trim_end support, so we pre-trim the file here. The aligner then sees a
    file that already starts at 0 and ends at trim_end - trim_start, and
    returns timestamps relative to 0. The browser shifts those back to
    absolute time by adding trim_start on its side.
    """
    out = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    out.close()
    cmd = ["ffmpeg", "-loglevel", "error", "-nostdin", "-y", "-i", src_path]
    if trim_start and float(trim_start) > 0:
        cmd.extend(["-ss", str(float(trim_start))])
    if trim_end and float(trim_end) > 0:
        cmd.extend(["-to", str(float(trim_end))])
    # Re-encode to MP3: -c copy can leave leading silence / bad headers on
    # cut boundaries. libmp3lame at VBR q=4 is fast and preserves alignment
    # quality (the model resamples to 16 kHz mono anyway).
    cmd.extend(["-c:a", "libmp3lame", "-q:a", "4", out.name])
    print(f"[handler] Pre-trim ffmpeg: -ss {trim_start or 0} -to {trim_end or 'end'}")
    subprocess.run(cmd, check=True, capture_output=True)
    os.unlink(src_path)
    print(f"[handler] Trimmed audio: {os.path.getsize(out.name) / 1024 / 1024:.1f} MB")
    return out.name


def _resolve_audio(inp):
    """Resolve audio input to a temp file path. Accepts audio_url or audio_base64.

    If trim_start / trim_end are provided, the audio is pre-trimmed with
    ffmpeg and the returned trim values are (None, None) so the aligner
    treats the file as fully in-range.
    """
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

    needs_trim = (trim_start and float(trim_start) > 0) or \
                 (trim_end and float(trim_end) > 0)
    if needs_trim:
        trimmed_path = _trim_audio(tmp.name, suffix, trim_start, trim_end)
        return trimmed_path, None, None

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
