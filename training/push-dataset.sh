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

PYTHONIOENCODING=utf-8 \
EVAL_FRACTION="${EVAL_FRACTION:-0.1}" \
LOCAL_DIR="$LOCAL_DIR" \
HF_REPO="$HF_REPO" \
"$VENV_PY" - <<'PYEOF'
import os
from datasets import load_from_disk, DatasetDict, Dataset
from huggingface_hub import login

token = os.environ.get("HF_TOKEN")
if token:
    login(token, add_to_git_credential=True)

LOCAL_DIR = os.environ["LOCAL_DIR"]
HF_REPO = os.environ["HF_REPO"]
EVAL_FRACTION = float(os.environ.get("EVAL_FRACTION", "0.1"))

ds = load_from_disk(LOCAL_DIR)
print(f"Loaded dataset: {ds}")

# Need both 'train' and 'eval' splits — train-whisper.py crashes on missing
# 'eval' key. If the dataset is a bare Dataset (no splits), do a 90/10 split.
if isinstance(ds, Dataset):
    print(f"Splitting bare dataset {len(ds)} rows → train/eval ({1-EVAL_FRACTION:.0%}/{EVAL_FRACTION:.0%})")
    s = ds.train_test_split(test_size=EVAL_FRACTION, seed=42)
    ds = DatasetDict({"train": s["train"], "eval": s["test"]})
elif isinstance(ds, DatasetDict) and "eval" not in ds:
    # Has 'train' but no 'eval' — split off eval from train
    if "train" in ds:
        print(f"DatasetDict missing 'eval' — splitting from 'train'")
        s = ds["train"].train_test_split(test_size=EVAL_FRACTION, seed=42)
        ds = DatasetDict({"train": s["train"], "eval": s["test"]})
    else:
        raise SystemExit(f"DatasetDict has no 'train' or 'eval' split: {list(ds.keys())}")

print(f"Final splits: { {k: len(v) for k,v in ds.items()} }")
ds.push_to_hub(HF_REPO, private=True)
print(f"\nPushed to: https://huggingface.co/datasets/{HF_REPO}")
PYEOF

echo ""
echo "✅ Dataset live on HF Hub. Pod will load via --train_datasets $HF_REPO:train"
