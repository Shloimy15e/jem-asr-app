#!/usr/bin/env bash
# Push a local HuggingFace dataset (built by scripts/build-training-dataset.sh)
# to HF Hub so the training pod can load it via --use_preprocessed.
#
# Usage:
#   bash training/push-dataset.sh <local-dataset-dir> <hf-repo>
#
# Example:
#   bash training/push-dataset.sh dist-training/parquet/jemedia abe1018776/jem-yi-whisper-training
#
# Env:
#   HF_TOKEN must be set (or you must have run `huggingface-cli login` already).

set -euo pipefail

LOCAL_DIR="${1:-}"
HF_REPO="${2:-}"

if [[ -z "$LOCAL_DIR" || -z "$HF_REPO" ]]; then
  echo "Usage: bash training/push-dataset.sh <local-dataset-dir> <hf-repo>" >&2
  echo "       bash training/push-dataset.sh dist-training/parquet/jemedia abe1018776/jem-yi-whisper-training" >&2
  exit 1
fi

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "❌ Local dataset dir not found: $LOCAL_DIR" >&2
  echo "   Run 'bash scripts/build-training-dataset.sh' first." >&2
  exit 1
fi

# Reuse the venv set up by build-training-dataset.sh — it already has
# datasets + huggingface_hub installed.
VENV_PY="./vendor/asr-training/.venv/Scripts/python.exe"
[[ ! -f "$VENV_PY" ]] && VENV_PY="./vendor/asr-training/.venv/bin/python"
if [[ ! -f "$VENV_PY" ]]; then
  echo "❌ ivrit-ai venv not found. Run bash scripts/build-training-dataset.sh first." >&2
  exit 1
fi

# Ensure HF auth. HF_TOKEN env takes precedence; otherwise fall back to cached login.
AUTH_EXPR="True"
if [[ -n "${HF_TOKEN:-}" ]]; then
  AUTH_EXPR="login('$HF_TOKEN', add_to_git_credential=True)"
fi

PYTHONIOENCODING=utf-8 "$VENV_PY" - <<PYEOF
from datasets import load_from_disk, DatasetDict
from huggingface_hub import HfApi, login
import os

token = os.environ.get("HF_TOKEN")
if token:
    login(token, add_to_git_credential=True)

ds = load_from_disk("$LOCAL_DIR")
print(f"Loaded dataset: {ds}")

# Wrap in DatasetDict under 'train' if it's a bare Dataset — so --use_preprocessed
# on the pod sees a well-formed split.
if not isinstance(ds, DatasetDict):
    ds = DatasetDict({"train": ds})

ds.push_to_hub("$HF_REPO", private=True)
print(f"\nPushed to: https://huggingface.co/datasets/$HF_REPO")
PYEOF

echo ""
echo "✅ Dataset live on HF Hub. Pod will load via --use_preprocessed $HF_REPO"
