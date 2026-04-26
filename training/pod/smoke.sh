#!/usr/bin/env bash
# 10-step smoke test: confirms the pod + dataset + ivrit-ai chain boots end-to-end.
#
# Overrides a few config vars to make training finish fast (no real model quality).
# Pass = loss prints for 10 steps, no crash, at least one checkpoint written.
#
# Usage (on the pod):
#   bash training/pod/smoke.sh

set -euo pipefail

# Override config for a minimal run
export MAX_STEPS=10
export EVAL_STEPS=5
export SAVE_STEPS=5
export NUM_TRAIN_EPOCHS=1
export PER_DEVICE_TRAIN_BATCH_SIZE=1
export GRADIENT_ACCUMULATION_STEPS=1
export RUN_NAME=jem-smoke
export OUTPUT_MODEL_NAME=jem-whisper-smoke-v1
# Don't merge adapter after smoke — waste of time
export SKIP_MERGE=1

exec bash "$(dirname "$0")/bootstrap.sh" "${1:-runpod/jem-trainer/configs/jem_lora_v1.env}"
