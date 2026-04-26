#!/usr/bin/env bash
# Two-stage preprocessing pipeline: JEM Supabase → ivrit-ai → HuggingFace dataset.
#
# Stage 1 (Node): pulls approved 50hr non-benchmark audio from Supabase + R2,
#                 writes per-file folders with audio.mp3 + transcript.aligned.json
#                 + metadata.json under <out>/<library>/<audio_id>/.
#
# Stage 2 (Python): ivrit-ai's create_dataset.py packs those folders into a
#                   HuggingFace dataset of 30s slices ready for Whisper fine-tune.
#
# First run clones ivrit-ai/asr-training to vendor/ and sets up a dedicated
# Python venv with pinned deps (av<14, audiosample==2.2.6, stable-ts).
# Subsequent runs reuse both — idempotent.
#
# Usage:
#   bash scripts/build-training-dataset.sh --id a_1013
#   bash scripts/build-training-dataset.sh --library jemedia --out ./dist-training
#   bash scripts/build-training-dataset.sh --stage 1 --dry-run
#   bash scripts/build-training-dataset.sh --stage 2 --out ./dist-training
#   bash scripts/build-training-dataset.sh --library jemedia --resume
#   bash scripts/build-training-dataset.sh --library jemedia --push-to-hub abe1018776/jem-yi-whisper-training
#
# Flags:
#   --id <audio_id>       Export a single audio (passed to Stage 1)
#   --library <id>        Scope to one library (default: all)
#   --out <dir>           Output root (default: ./dist-training)
#   --stage <1|2|both>    Which stage to run (default: both)
#   --dry-run             Stage 1 dry-run (no writes); skips Stage 2
#   --force               Re-export even if Stage 1 output exists
#   --resume              Skip Stage 1 entries whose output is complete
#   --push-to-hub <repo>  After Stage 2, push each library's dataset to HF Hub (<org>/<name>)
#   --limit <N>           Stage 1 only: cap number of files exported
#   --help                Show this message

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# ── Args ────────────────────────────────────────────────────────────────
ID_FILTER=""
LIBRARY_FILTER=""
OUT_DIR="./dist-training"
STAGE="both"
DRY_RUN=false
FORCE=false
RESUME=false
PUSH_TO_HUB=""
LIMIT=""

usage() {
  sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)           ID_FILTER="$2"; shift 2;;
    --library)      LIBRARY_FILTER="$2"; shift 2;;
    --out)          OUT_DIR="$2"; shift 2;;
    --stage)        STAGE="$2"; shift 2;;
    --dry-run)      DRY_RUN=true; shift;;
    --force)        FORCE=true; shift;;
    --resume)       RESUME=true; shift;;
    --push-to-hub)  PUSH_TO_HUB="$2"; shift 2;;
    --limit)        LIMIT="$2"; shift 2;;
    --help|-h)      usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

if [[ "$STAGE" != "1" && "$STAGE" != "2" && "$STAGE" != "both" ]]; then
  echo "❌ --stage must be 1, 2, or both (got: $STAGE)" >&2
  exit 1
fi

# ── Prereq checks ───────────────────────────────────────────────────────
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Required command not found on PATH: $1" >&2
    [[ -n "${2:-}" ]] && echo "   $2" >&2
    exit 1
  fi
}

need node "Install Node.js 18+ from https://nodejs.org"
need ffmpeg "Install ffmpeg from https://ffmpeg.org/download.html (or: winget install ffmpeg)"
need git

# Find a Python 3.10–3.12 to host the venv. ivrit-ai's deps (notably torch
# via stable-ts, plus av/audiosample) may not have wheels for very new
# Python (3.13+). Resolve to a concrete executable path so later invocations
# are unambiguous.
PYTHON_HOST=""
resolve_py() {
  # Usage: resolve_py <cmd...> — runs `<cmd> -c 'print sys.executable'`
  # and echoes the path if it's a supported version (3.10/3.11/3.12).
  local exe
  exe=$("$@" -c 'import sys; v=sys.version_info; print(sys.executable if v[:2] in ((3,10),(3,11),(3,12)) else "")' 2>/dev/null || true)
  [[ -n "$exe" && -f "$exe" ]] && echo "$exe"
}

# 1. Windows `py` launcher (can select any installed version)
if command -v py >/dev/null 2>&1; then
  for v in 3.12 3.11 3.10; do
    exe=$(resolve_py py "-$v") && [[ -n "$exe" ]] && PYTHON_HOST="$exe" && break
  done
fi

# 2. Versioned binaries on PATH (Unix convention)
if [[ -z "$PYTHON_HOST" ]]; then
  for cmd in python3.12 python3.11 python3.10; do
    if command -v "$cmd" >/dev/null 2>&1; then
      exe=$(resolve_py "$cmd") && [[ -n "$exe" ]] && PYTHON_HOST="$exe" && break
    fi
  done
fi

# 3. Fallback: whatever `python` is, even if it's outside the supported range.
if [[ -z "$PYTHON_HOST" ]]; then
  for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      exe=$("$cmd" -c 'import sys; print(sys.executable)' 2>/dev/null || true)
      if [[ -n "$exe" && -f "$exe" ]]; then
        ver=$("$cmd" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))' 2>/dev/null || echo "?")
        echo "⚠  No Python 3.10–3.12 found. Falling back to $cmd ($ver)." >&2
        echo "   If wheel installs fail (common on 3.13+), install Python 3.12 from" >&2
        echo "   https://python.org and rerun." >&2
        PYTHON_HOST="$exe"
        break
      fi
    fi
  done
fi

if [[ -z "$PYTHON_HOST" ]]; then
  echo "❌ No Python found on PATH. Install Python 3.12 from https://python.org" >&2
  exit 1
fi

# ── Load SUPABASE_* from .env if not already in env (Stage 1 only) ──────
if [[ "$STAGE" != "2" ]]; then
  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
    if [[ -f .env ]]; then
      while IFS='=' read -r k v; do
        case "$k" in
          SUPABASE_URL|SUPABASE_SERVICE_KEY|VITE_SUPABASE_URL)
            export "$k=$v";;
        esac
      done < <(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_KEY|VITE_SUPABASE_URL)=' .env || true)
    fi
    : "${SUPABASE_URL:=${VITE_SUPABASE_URL:-}}"
    export SUPABASE_URL
  fi

  if [[ -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
    cat >&2 <<EOF
❌ SUPABASE_SERVICE_KEY is not set.

   Add to .env (in the repo root):
     SUPABASE_SERVICE_KEY=<service-role-JWT>

   Find the key at:
     Supabase Dashboard → Settings → API → service_role (secret)

   The service role key bypasses RLS so the script can read reviews,
   alignments, and audio_files across all libraries.
EOF
    exit 1
  fi
fi

# ── Ensure node_modules ─────────────────────────────────────────────────
if [[ "$STAGE" != "2" ]]; then
  if [[ ! -d node_modules/@supabase ]]; then
    echo "📦 Installing Node dependencies…"
    npm install --silent
  fi
fi

# ── Ensure ivrit-ai repo cloned ─────────────────────────────────────────
IVRIT_DIR="./vendor/asr-training"
if [[ ! -d "$IVRIT_DIR/.git" ]]; then
  echo "📦 Cloning ivrit-ai/asr-training → $IVRIT_DIR…"
  mkdir -p ./vendor
  git clone --depth 1 https://github.com/ivrit-ai/asr-training "$IVRIT_DIR"
fi

# ── Ensure Python venv with pinned deps ─────────────────────────────────
VENV_DIR="$IVRIT_DIR/.venv"
if [[ -f "$VENV_DIR/Scripts/python.exe" ]]; then
  PYTHON="$VENV_DIR/Scripts/python.exe"
  PIP="$VENV_DIR/Scripts/pip.exe"
elif [[ -f "$VENV_DIR/bin/python" ]]; then
  PYTHON="$VENV_DIR/bin/python"
  PIP="$VENV_DIR/bin/pip"
else
  echo "📦 Creating Python venv at $VENV_DIR…"
  "$PYTHON_HOST" -m venv "$VENV_DIR"
  if [[ -f "$VENV_DIR/Scripts/python.exe" ]]; then
    PYTHON="$VENV_DIR/Scripts/python.exe"
    PIP="$VENV_DIR/Scripts/pip.exe"
  else
    PYTHON="$VENV_DIR/bin/python"
    PIP="$VENV_DIR/bin/pip"
  fi
fi

# Check for Stage 2 deps; install if missing.
if ! "$PYTHON" -c "import stable_whisper, audiosample, datasets, av, huggingface_hub, soundfile" >/dev/null 2>&1; then
  echo "📦 Installing Python deps into venv (first run only, ~1GB)…"
  # `python -m pip` (not pip.exe) — Windows can't overwrite pip.exe while it's running.
  # Pinned versions: newer `av` removes `Flags.FAST_SEEK` that audiosample<=2.2.6 uses.
  # ivrit-ai's requirements.txt itself caps av<14. We install a minimal subset
  # for Stage 2 only (torch comes transitively via stable-ts/openai-whisper).
  # `soundfile` is needed by HF datasets to encode the Audio() column.
  "$PYTHON" -m pip install --quiet \
    'stable-ts' \
    'av>=12.3.0,<14' \
    'audiosample==2.2.6' \
    'datasets<4.0.0' \
    'huggingface_hub' \
    'soundfile' \
    'tqdm' \
    'numpy'
fi

# ── Stage 1: Node export ────────────────────────────────────────────────
if [[ "$STAGE" == "1" || "$STAGE" == "both" ]]; then
  echo ""
  echo "── Stage 1: Export from Supabase → ivrit-ai folder format ──"
  STAGE1_ARGS=(--out "$OUT_DIR")
  [[ -n "$ID_FILTER" ]]      && STAGE1_ARGS+=(--id "$ID_FILTER")
  [[ -n "$LIBRARY_FILTER" ]] && STAGE1_ARGS+=(--library "$LIBRARY_FILTER")
  [[ "$DRY_RUN" == true ]]   && STAGE1_ARGS+=(--dry-run)
  [[ "$FORCE"   == true ]]   && STAGE1_ARGS+=(--force)
  [[ "$RESUME"  == true ]]   && STAGE1_ARGS+=(--resume)
  [[ -n "$LIMIT" ]]          && STAGE1_ARGS+=(--limit "$LIMIT")
  node scripts/export-approved-to-ivrit.mjs "${STAGE1_ARGS[@]}"
fi

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "(dry run — Stage 2 skipped)"
  exit 0
fi

# ── Stage 2: Python create_dataset ──────────────────────────────────────
if [[ "$STAGE" == "2" || "$STAGE" == "both" ]]; then
  echo ""
  echo "── Stage 2: Build HuggingFace dataset (30s Whisper slices) ──"

  DATASET_OUT="$OUT_DIR/parquet"
  mkdir -p "$DATASET_OUT"

  shopt -s nullglob
  libraries=()
  if [[ -n "$LIBRARY_FILTER" ]]; then
    [[ -d "$OUT_DIR/$LIBRARY_FILTER" ]] && libraries+=("$LIBRARY_FILTER")
  else
    for d in "$OUT_DIR"/*/; do
      name=$(basename "$d")
      [[ "$name" == "parquet" ]] && continue
      libraries+=("$name")
    done
  fi

  if [[ ${#libraries[@]} -eq 0 ]]; then
    echo "⚠  No library folders under $OUT_DIR — nothing to convert." >&2
    exit 0
  fi

  for lib in "${libraries[@]}"; do
    echo ""
    echo "▶ $lib"
    PYTHONIOENCODING=utf-8 "$PYTHON" "$IVRIT_DIR/create_dataset.py" "$OUT_DIR/$lib" \
      --segments_filename_glob 'transcript.aligned.json' \
      --output_dataset_name "$DATASET_OUT/$lib" \
      --num_proc 1 \
      --per_proc_per_chunk_size 1 \
      --copy_metadata_fields source_entry_id document_language
  done

  echo ""
  echo "✅ Dataset(s) saved to: $DATASET_OUT"
  echo "   Next: load with"
  echo "     from datasets import load_from_disk"
  echo "     ds = load_from_disk('$DATASET_OUT/<library>')"
fi

# ── Optional Stage 3: push to HF Hub ────────────────────────────────────
if [[ -n "$PUSH_TO_HUB" ]]; then
  echo ""
  echo "── Stage 3: Push dataset → HF Hub ($PUSH_TO_HUB) ──"

  if [[ -z "${HF_TOKEN:-}" ]]; then
    # Fall back to cached huggingface-cli login
    if ! "$PYTHON" -c "from huggingface_hub import HfApi; HfApi().whoami()" >/dev/null 2>&1; then
      cat >&2 <<EOF
❌ HF_TOKEN not set and no cached HF login detected.

   Either export HF_TOKEN=<hf-write-token> or run once:
     "$PYTHON" -m huggingface_hub.commands.huggingface_cli login
EOF
      exit 1
    fi
  fi

  # If --library was set, push just that one; otherwise push each library to
  # <repo>__<library> so we don't cross-polute the hub repo.
  if [[ -n "$LIBRARY_FILTER" ]]; then
    bash training/push-dataset.sh "$OUT_DIR/parquet/$LIBRARY_FILTER" "$PUSH_TO_HUB"
  else
    for lib in "${libraries[@]}"; do
      target="${PUSH_TO_HUB}__${lib}"
      echo ""
      echo "▶ Pushing $lib → $target"
      bash training/push-dataset.sh "$OUT_DIR/parquet/$lib" "$target"
    done
  fi
fi
