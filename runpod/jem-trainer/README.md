# jem-trainer — serverless Whisper fine-tuner

RunPod serverless worker that runs `ivrit-ai/asr-training`'s `train-whisper.py` against a HuggingFace dataset. Input = job JSON; output = trained model on HF Hub.

## Image contents

- `pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime` base
- `ffmpeg`, `libsndfile1`, `git`
- `ivrit-ai/asr-training` cloned at `/app/asr-training`
- All of ivrit-ai's requirements + `runpod` SDK + `wandb`
- Configs copied into `/app/configs/` from `training/configs/`

## Build + push

`.github/workflows/build-jem-trainer.yml` auto-builds on pushes that touch `runpod/jem-trainer/**` or `training/configs/**`. Image lands at:

    ghcr.io/<github-org>/jem-trainer:latest
    ghcr.io/<github-org>/jem-trainer:<sha>

Manual build (from repo root):

```bash
docker build -f runpod/jem-trainer/Dockerfile -t jem-trainer:dev .
```

## Create the RunPod endpoint

1. RunPod dashboard → Serverless → New Endpoint
2. Image: `ghcr.io/<your-org>/jem-trainer:latest`
3. GPU: **A6000 (48GB)** for LoRA, **A100-80GB** for full fine-tune
4. Worker settings:
   - **Max workers**: 1 (for smoke tests) — bump later for parallel jobs
   - **Idle timeout**: 5s (don't pay for idle)
   - **Execution timeout**: **86400s (24h)** — training is long; leave plenty of headroom
   - **Scale type**: QUEUE_DELAY
5. Env secrets:
   - `HF_TOKEN` — required (HuggingFace write token)
   - `WANDB_API_KEY` — optional (tracks training to W&B)
   - `WANDB_PROJECT` — optional (default `jem-whisper-finetune`)

## Submit a job

Use `/run` (async), not `/runsync` — training always exceeds the 240s sync limit.

### Smoke test (10 steps)

```bash
curl -X POST \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  https://api.runpod.ai/v2/<endpoint-id>/run \
  -d '{
    "input": {
      "config": "jem_lora_v1",
      "max_steps": 10,
      "output_model_name": "jem-whisper-smoke-v1"
    }
  }'
```

Response: `{"id": "<job-id>", ...}`. Poll status:

```bash
curl -H "Authorization: Bearer $RUNPOD_API_KEY" \
  https://api.runpod.ai/v2/<endpoint-id>/status/<job-id>
```

### Full LoRA run (defaults from config)

```bash
curl -X POST \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  https://api.runpod.ai/v2/<endpoint-id>/run \
  -d '{
    "input": {
      "config": "jem_lora_v1",
      "dataset_repo": "abe1018776/jem-yi-whisper-training",
      "output_model_name": "jem-whisper-lora-v1"
    }
  }'
```

### Override any config key

```json
{
  "input": {
    "config": "jem_lora_v1",
    "overrides": {
      "LEARNING_RATE": "5e-5",
      "WARMUP_STEPS": "50",
      "PREDICT_WER": "1"
    }
  }
}
```

## Input schema

| Key | Type | Description |
|-----|------|-------------|
| `config` | string | Config name in `/app/configs/` (`jem_lora_v1`, `jem_full_v1`). Default: `jem_lora_v1`. |
| `dataset_repo` | string | Overrides `HF_DATASET_REPO` from config. |
| `output_model_name` | string | Overrides `OUTPUT_MODEL_NAME`. Use for smoke runs to avoid overwriting prod. |
| `max_steps` | int | Caps training iterations. For smoke tests. |
| `overrides` | dict | Any `KEY: value` pair; overrides the corresponding config entry verbatim. |

## Output schema

**Success:**
```json
{
  "status": "completed",
  "config": "jem_lora_v1",
  "dataset": "<org>/<dataset>",
  "model_repo": "<org>/<model>",
  "model_url": "https://huggingface.co/<org>/<model>"
}
```

**Failure:**
```json
{
  "status": "failed" | "error",
  "error": "...",
  "returncode": 1,
  "traceback": "..."
}
```

## Logs

- **RunPod dashboard** → Workers → log tail (stdout/stderr streamed live)
- **W&B dashboard** → `jem-whisper-finetune` project → per-step loss + WER (if `PREDICT_WER=1`)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `HF_TOKEN not set` | Endpoint missing secret | Add `HF_TOKEN` in RunPod endpoint env |
| `Unknown config: <name>` | Config file not in image | Make sure `training/configs/<name>.env` exists in the branch you built |
| `train-whisper.py exited with code 1` | Many — check pod logs | Most commonly OOM; decrease `PER_DEVICE_TRAIN_BATCH_SIZE` or bump to larger GPU |
| Cold start > 3 min | Image pull | Expected on first run per worker. Warm starts are fast. |
| Job queued forever | No active worker + `Max workers: 0` | Bump `Max workers` to 1 |
