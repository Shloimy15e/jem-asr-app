# Training — JEM ASR fine-tuning on RunPod

This directory is a thin wrapper around [ivrit-ai/asr-training](https://github.com/ivrit-ai/asr-training). We don't fork their training scripts — we just hand them a config.

## End-to-end flow

```
┌──────────────────────────┐    ┌──────────────────────┐    ┌────────────────┐
│ scripts/                 │    │ training/            │    │ RunPod GPU     │
│ build-training-dataset   │──▶ │ push-dataset.sh      │──▶ │ pod/bootstrap  │
│ (export + Stage 2)       │    │ (HF Hub upload)      │    │ (train-whisper)│
└──────────────────────────┘    └──────────────────────┘    └────────────────┘
 dist-training/parquet/         HF Hub: <org>/<dataset>      HF Hub: <org>/<model>
```

## 1. Build + push the dataset (local)

```bash
# Build the parquet dataset and push to HF Hub in one command:
bash scripts/build-training-dataset.sh --library jemedia --push-to-hub abe1018776/jem-yi-whisper-training

# …or separately:
bash scripts/build-training-dataset.sh --library jemedia
bash training/push-dataset.sh dist-training/parquet/jemedia abe1018776/jem-yi-whisper-training
```

Requires `HF_TOKEN` in env (or prior `huggingface-cli login`).

## 2. Launch a RunPod GPU

Any CUDA 12+ image works. Tested: `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`.

Minimum specs for LoRA on Whisper-large-v3-turbo: 1× A6000 (48 GB) or A100 (40 GB). For full fine-tune: A100 80 GB.

Pod secrets to set:
- `HF_TOKEN` — HuggingFace write token
- `WANDB_API_KEY` — optional, enables W&B tracking

## 3. Train (on the pod)

```bash
# SSH into the pod, then:
git clone https://github.com/<your-org>/jem-asr-app.git
cd jem-asr-app

# Smoke test (10 training steps, ~5 min):
bash training/pod/smoke.sh

# Real LoRA run:
bash training/pod/bootstrap.sh runpod/jem-trainer/configs/jem_lora_v1.env

# Full fine-tune (requires more data):
bash training/pod/bootstrap.sh runpod/jem-trainer/configs/jem_full_v1.env
```

`bootstrap.sh` clones ivrit-ai, pip-installs its deps, sources the config env file, and calls `train-whisper.py` with all the flags set.

## Configs

Each config is a shell env file — `KEY=VALUE` maps 1:1 to a `train-whisper.py` flag. No parser layer. To see every available flag:

```bash
python vendor/asr-training/train-whisper.py --help
```

### Included configs
- **`jem_lora_v1.env`** — QLoRA on `ivrit-ai/yi-whisper-large-v3-turbo`. Small-data friendly. Use as a Rebbe-specialty adapter on top of a strong Yiddish base.
- **`jem_full_v1.env`** — full-parameter fine-tune of `ivrit-ai/yi-whisper-large-v3-turbo` on approved JEM data only. Use with >50h of approved data.
- **`jem_base_v2.env`** — full-parameter fine-tune of `openai/whisper-large-v3-turbo` from scratch on the **pooled** Yiddish corpus (ivrit-ai recital + ivrit-ai whatsapp + Facebook omnilingual ydd_Hebr). ~110h training, ~1.5h disjoint-speaker eval. Mirrors ivrit-ai's published yi-whisper recipe. Run **before** `jem_lora_v1.env` to build a stronger base, then fine-tune the Rebbe LoRA on top.

> **Multi-dataset pooling.** ivrit-ai's `train-whisper.py` accepts `--train_datasets` as `nargs="*"` and runs `concatenate_datasets()` across them (in `preprocess/preperator.py:process_datasets`). Pooling is proportional to row counts — it does NOT interleave with weights. Bootstrap.sh splits the env var on whitespace via `read -ra` so a config can list multiple datasets like:
> ```
> TRAIN_DATASETS="ivrit-ai/foo:train ivrit-ai/bar:train ABE101/baz:train"
> EVAL_DATASETS="ABE101/baz:dev"
> ```

### Tuning
To experiment, copy a config and edit. Common overrides:
- `BASE_MODEL` — try `openai/whisper-large-v3` for a clean baseline (not ivrit-tuned)
- `NUM_TRAIN_EPOCHS`, `LEARNING_RATE`, `WARMUP_STEPS` — the usual knobs
- `EVAL_DATASETS` — add a held-out dataset for WER-based best-model selection (then set `PREDICT_WER=1`)

### Pre-training step for jem_base_v2.env
The omnilingual dataset needs schema conversion (omnilingual uses `raw_text`, ivrit-ai's preparator requires `transcript`). Run once:
```bash
python scripts/convert-omnilingual-to-ivrit-format.py \
    --target-repo ABE101/omnilingual-ydd-Hebr-ivrit-format
```
The script also strips `<hesitation>` markup and lone surrogates from the source text, then pushes train/dev/test splits to HF Hub.

## Known limitations (v1)

1. **No frozen-encoder option.** ivrit-ai's `--use_qlora` adapts all Whisper params. For heavy speaker-adaptation on <10h data, freezing the encoder helps regularize; we accept slight quality loss on v1 in exchange for not forking the upstream trainer. Follow-up: upstream PR for `--freeze_encoder`.
2. **No automatic eval split.** Our Stage 2 dataset ships as `train` only. `PREDICT_WER=1` needs an eval dataset — either rebuild Stage 2 with `--validation_split_size` (modify `scripts/build-training-dataset.sh`) or push a separate held-out set.
3. **Dockerfile for persistent pod deferred.** First run installs Python deps on the pod (~5 min one-time). For serverless, we bake a full image — see `runpod/jem-trainer/`.

## Files

```
training/
├── README.md                    # this file
├── pod/
│   ├── bootstrap.sh             # run on persistent pod — clones ivrit-ai + trains
│   └── smoke.sh                 # 10-step integration test (persistent pod)
└── push-dataset.sh              # local — pushes dist-training/parquet/... to HF Hub

runpod/jem-trainer/              # serverless worker (Path B, default)
├── Dockerfile
├── handler.py
├── configs/                     # canonical config home — sourced by BOTH paths
│   ├── jem_lora_v1.env          # default: QLoRA fine-tune
│   └── jem_full_v1.env          # full-parameter fine-tune
└── README.md
```
