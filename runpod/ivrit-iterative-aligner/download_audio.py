"""
Standalone audio downloader for the serverless pod.

Fetches a public R2 (or any HTTPS) audio URL and writes it to the pod's local
disk before alignment runs. Keeping this as a separate script means:

  * The alignment step always reads from a real local file — no network stalls
    partway through a long transcribe.
  * The download is streamed in chunks, so multi-hour audio never balloons RAM.
  * ffprobe verifies the file is a playable audio stream before we hand it off.

Can be invoked as:
    python download_audio.py <url> [--dest /path/to/out.mp3]

Or imported:
    from download_audio import download_to_vm
    local_path, duration = download_to_vm(url)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

DEFAULT_DIR = os.environ.get("AUDIO_DOWNLOAD_DIR", "/tmp/ivrit-audio")
CHUNK_SIZE = 1024 * 1024  # 1 MiB
CONNECT_TIMEOUT = 30
READ_TIMEOUT = 300  # per-chunk read timeout for long downloads
MAX_RETRIES = 3

KNOWN_SUFFIXES = {".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac",
                  ".opus", ".webm", ".mp4", ".mkv"}


def _suffix_from_url(url: str) -> str:
    path = urlparse(url).path
    name = path.rsplit("/", 1)[-1]
    if "." in name:
        suf = "." + name.rsplit(".", 1)[-1].lower()
        if suf in KNOWN_SUFFIXES:
            return suf
    return ".mp3"


def _head(url: str) -> tuple[int | None, str | None]:
    try:
        r = requests.head(url, timeout=CONNECT_TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        size = int(r.headers["Content-Length"]) if "Content-Length" in r.headers else None
        ctype = r.headers.get("Content-Type")
        return size, ctype
    except Exception as e:
        print(f"[download] HEAD failed ({e}); continuing without size hint")
        return None, None


def _probe(path: str) -> float:
    """Return audio duration in seconds. Raises if ffprobe can't decode it."""
    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        path,
    ]
    out = subprocess.check_output(cmd, timeout=60).decode("utf-8")
    info = json.loads(out)
    fmt = info.get("format", {})
    streams = info.get("streams", [])
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio is None:
        raise RuntimeError(f"No audio stream found in {path}")
    duration = float(fmt.get("duration") or audio.get("duration") or 0.0)
    if duration <= 0:
        raise RuntimeError(f"Audio duration reported as {duration} for {path}")
    return duration


def download_to_vm(
    url: str,
    dest: str | None = None,
    log_every_mb: int = 25,
) -> tuple[str, float]:
    """Download `url` to the pod's local disk and verify it's playable.

    Returns:
        (absolute_path, duration_seconds)
    """
    if not url or not url.startswith(("http://", "https://")):
        raise ValueError(f"Refusing to download non-HTTP url: {url!r}")

    os.makedirs(DEFAULT_DIR, exist_ok=True)
    expected_size, ctype = _head(url)
    suffix = _suffix_from_url(url)

    if dest:
        target = Path(dest)
        target.parent.mkdir(parents=True, exist_ok=True)
    else:
        fd, tmp_name = tempfile.mkstemp(suffix=suffix, dir=DEFAULT_DIR, prefix="audio_")
        os.close(fd)
        target = Path(tmp_name)

    if expected_size:
        print(f"[download] {url} -> {target} ({expected_size / 1024 / 1024:.1f} MB, {ctype})")
    else:
        print(f"[download] {url} -> {target} (size unknown, {ctype})")

    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        t0 = time.time()
        written = 0
        next_log_bytes = log_every_mb * 1024 * 1024
        try:
            with requests.get(
                url,
                stream=True,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                allow_redirects=True,
            ) as resp:
                resp.raise_for_status()
                with open(target, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                        if not chunk:
                            continue
                        fh.write(chunk)
                        written += len(chunk)
                        if written >= next_log_bytes:
                            mb = written / 1024 / 1024
                            print(f"[download] {mb:.0f} MB ({time.time() - t0:.1f}s)")
                            next_log_bytes += log_every_mb * 1024 * 1024
            break
        except (requests.RequestException, OSError) as e:
            last_error = e
            print(f"[download] attempt {attempt}/{MAX_RETRIES} failed: {e}")
            if attempt == MAX_RETRIES:
                try:
                    target.unlink()
                except OSError:
                    pass
                raise RuntimeError(f"Download failed after {MAX_RETRIES} attempts: {e}") from e
            time.sleep(2 ** attempt)

    size_on_disk = target.stat().st_size
    if expected_size and size_on_disk != expected_size:
        print(f"[download] WARNING: size mismatch, got {size_on_disk} expected {expected_size}")
    if size_on_disk == 0:
        target.unlink(missing_ok=True)
        raise RuntimeError("Downloaded file is empty")

    duration = _probe(str(target))
    print(f"[download] OK: {size_on_disk / 1024 / 1024:.1f} MB, {duration:.1f}s audio, "
          f"took {time.time() - t0:.1f}s")
    return str(target), duration


def main() -> int:
    p = argparse.ArgumentParser(description="Download a public audio URL to the local VM.")
    p.add_argument("url", help="Public HTTPS audio URL (R2, S3, etc.)")
    p.add_argument("--dest", help="Optional explicit output path")
    args = p.parse_args()

    path, duration = download_to_vm(args.url, dest=args.dest)
    print(json.dumps({"path": path, "duration": duration}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
