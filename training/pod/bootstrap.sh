#!/usr/bin/env bash
# Run ON the RunPod after `git clone jem-asr-app` and `cd jem-asr-app`.
#
# Clones ivrit-ai's asr-training, installs its pinned deps, sources a config
# file, and calls train-whisper.py directly — no custom Python layer.
#
# Assumes the dataset has already been pushed to HF Hub via
# training/push-dataset.sh (run locally before launching the pod).
#
# Required env (set in RunPod secrets or exported before calling):
#   HF_TOKEN          — HuggingFace Hub token (read+write)
#   WANDB_API_KEY     — optional; enables Weights & Biases tracking
#
# Usage:
#   bash training/pod/bootstrap.sh [path/to/config.env]
#   (defaults to runpod/jem-trainer/configs/jem_lora_v1.env)

set -euo pipefail

CFG="${1:-runpod/jem-trainer/configs/jem_lora_v1.env}"
if [[ ! -f "$CFG" ]]; then
  echo "❌ Config not found: $CFG" >&2
  exit 1
fi

# Allow inline env overrides — e.g. NUM_TRAIN_EPOCHS=8 bash bootstrap.sh ...
# Snapshot any pre-set values for known config keys, source the config, then
# re-apply the snapshot so the inline value wins over the file's default.
_OVERRIDE_FILE=$(mktemp)
trap 'rm -f "$_OVERRIDE_FILE"' EXIT
for _v in HF_DATASET_REPO HF_MODEL_ORG OUTPUT_MODEL_NAME BASE_MODEL TARGET_LANGUAGE \
          USE_QLORA MIXED_PRECISION PER_DEVICE_TRAIN_BATCH_SIZE \
          PER_DEVICE_EVAL_BATCH_SIZE GRADIENT_ACCUMULATION_STEPS LEARNING_RATE \
          WARMUP_STEPS NUM_TRAIN_EPOCHS WEIGHT_DECAY EVAL_STEPS SAVE_STEPS \
          LOGGING_STEPS MAX_CHECKPOINTS_TO_KEEP PREDICT_WER \
          INCLUDE_TIMESTAMPS_PROB INCLUDE_PREV_TEXT_PROB EVAL_DATASETS RUN_NAME \
          MAX_STEPS SKIP_MERGE; do
  if [[ -n "${!_v+x}" ]]; then
    printf '%s=%q\n' "$_v" "${!_v}" >> "$_OVERRIDE_FILE"
  fi
done

# shellcheck disable=SC1090
source "$CFG"
# Re-apply inline overrides (sourced AFTER config so they win)
# shellcheck disable=SC1090
source "$_OVERRIDE_FILE"

: "${HF_TOKEN:?HF_TOKEN must be set (RunPod secrets or exported)}"

# ── System deps ─────────────────────────────────────────────────────────
apt-get update -qq && apt-get install -y -qq ffmpeg libsndfile1 git

# ── Clone ivrit-ai (fresh each pod launch) ──────────────────────────────
IVRIT_DIR=/workspace/asr-training
if [[ ! -d "$IVRIT_DIR/.git" ]]; then
  echo "📦 Cloning ivrit-ai/asr-training…"
  git clone --depth 1 https://github.com/ivrit-ai/asr-training "$IVRIT_DIR"
fi

cd "$IVRIT_DIR"

# ── Patch train-whisper.py (idempotent) ─────────────────────────────────
# Disable HF Trainer's best-model metric lookup. The script defaults to
# metric_for_best_model="loss" (or "wer" with --predict_wer), which causes
# the trainer to look up eval_loss / eval_wer at every eval step — but
# QLoRA + Whisper eval doesn't return those keys, so the trainer crashes
# with KeyError: 'eval_loss' after the first eval boundary.
# load_best_model_at_end is already False in train-whisper.py, so disabling
# the metric is safe (no model-loading behavior depends on it).
if grep -q 'metric_for_best_model="wer" if args.predict_wer else "loss"' train-whisper.py; then
  sed -i 's|metric_for_best_model="wer" if args.predict_wer else "loss"|metric_for_best_model=None|' train-whisper.py
  echo "✓ Patched metric_for_best_model → None"
fi

# ── Python deps (full training stack — torch, peft, transformers, etc.) ─
echo "📦 Installing Python deps…"
# Pin setuptools<81 in pip's isolated build env so packages with legacy
# setup.py (openai-whisper) can still import pkg_resources. Setuptools 81
# removed pkg_resources; the constraint propagates into pip-build-env-*.
PIP_CONSTRAINT_FILE=$(mktemp)
trap 'rm -f "$_OVERRIDE_FILE" "$PIP_CONSTRAINT_FILE"' EXIT
echo "setuptools<81" > "$PIP_CONSTRAINT_FILE"
PIP_CONSTRAINT="$PIP_CONSTRAINT_FILE" pip install -q -r requirements.txt
PIP_CONSTRAINT="$PIP_CONSTRAINT_FILE" pip install -q wandb

# ── Auth ────────────────────────────────────────────────────────────────
python -c "from huggingface_hub import login; login('$HF_TOKEN', add_to_git_credential=True)"
if [[ -n "${WANDB_API_KEY:-}" ]]; then
  wandb login "$WANDB_API_KEY"
  export WANDB_PROJECT="${WANDB_PROJECT:-jem-whisper-finetune}"
else
  # transformers Trainer auto-imports wandb when the package is installed,
  # then crashes if no API key is configured. Disable explicitly.
  export WANDB_DISABLED=true
fi

# ── Assemble train-whisper.py args ──────────────────────────────────────
# We use --train_datasets (raw audio + text) NOT --use_preprocessed (already
# feature-extracted). Our Stage 2 (create_dataset.py) outputs raw audio that
# train-whisper.py extracts features from on the fly.
# --eval_datasets defaults to the same repo's "eval" split — push-dataset.sh
# splits 90/10 before pushing.
TRAIN_DS="${TRAIN_DATASETS:-${HF_DATASET_REPO}:train}"
EVAL_DS="${EVAL_DATASETS:-${HF_DATASET_REPO}:eval}"

ARGS=(
  --train_datasets   "$TRAIN_DS"
  --eval_datasets    "$EVAL_DS"
  --model_name       "$BASE_MODEL"
  --target_language  "$TARGET_LANGUAGE"
  --output_model_name "$OUTPUT_MODEL_NAME"
  --hf_org_name      "$HF_MODEL_ORG"
  --per_device_train_batch_size "$PER_DEVICE_TRAIN_BATCH_SIZE"
  --per_device_eval_batch_size  "$PER_DEVICE_EVAL_BATCH_SIZE"
  --gradient_accumulation_steps "$GRADIENT_ACCUMULATION_STEPS"
  --learning_rate    "$LEARNING_RATE"
  --warmup_steps     "$WARMUP_STEPS"
  --num_train_epochs "$NUM_TRAIN_EPOCHS"
  --weight_decay     "$WEIGHT_DECAY"
  --eval_steps       "$EVAL_STEPS"
  --save_steps       "$SAVE_STEPS"
  --logging_steps    "$LOGGING_STEPS"
  --mixed_precision  "$MIXED_PRECISION"
  --include_timestamps_prob "$INCLUDE_TIMESTAMPS_PROB"
  --include_prev_text_prob  "$INCLUDE_PREV_TEXT_PROB"
  --run_name         "$RUN_NAME"
  --save_only_model
)

[[ "${USE_QLORA:-0}" == "1" ]]    && ARGS+=(--use_qlora)
[[ "${PREDICT_WER:-0}" == "1" ]]  && ARGS+=(--predict_wer)
[[ -n "${MAX_CHECKPOINTS_TO_KEEP:-}" ]] && ARGS+=(--max_checkpoints_to_keep "$MAX_CHECKPOINTS_TO_KEEP")
[[ -n "${MAX_STEPS:-}" ]]         && ARGS+=(--max_steps "$MAX_STEPS")

echo ""
echo "── Launching train-whisper.py ────────────────────────────────"
echo "Base model:  $BASE_MODEL"
echo "Dataset:     $HF_DATASET_REPO"
echo "Output:      $HF_MODEL_ORG/$OUTPUT_MODEL_NAME"
echo "Method:      $([ "${USE_QLORA:-0}" = "1" ] && echo QLoRA || echo full-finetune)"
echo ""

python train-whisper.py "${ARGS[@]}"

# ── Optional: merge LoRA adapter into base weights for easy deployment ──
if [[ "${USE_QLORA:-0}" == "1" && -z "${SKIP_MERGE:-}" ]]; then
  echo ""
  echo "── Merging LoRA adapter → ${OUTPUT_MODEL_NAME}-merged ──"
  python merge-lora-whisper.py \
    --base-model "$BASE_MODEL" \
    --adapter    "$HF_MODEL_ORG/$OUTPUT_MODEL_NAME" \
    --output     "${OUTPUT_MODEL_NAME}-merged" || \
    echo "⚠  merge-lora-whisper.py failed — adapter is still usable standalone"
fi

echo ""
echo "✅ Done. Model pushed to: https://huggingface.co/$HF_MODEL_ORG/$OUTPUT_MODEL_NAME"
