# jem-exporter — RunPod serverless dataset builder

Cloud alternative to running `bash scripts/build-training-dataset.sh` locally.
This pod runs the **same script unchanged** — it just provisions an
environment with everything pre-installed and exposes the run as a RunPod
serverless endpoint.

| Concern | Local CLI | This pod |
|---|---|---|
| Bootstrap (clone ivrit-ai, build venv) | ~5–10 min on first run | baked into image |
| `npm install` for Stage 1 deps | ~30s on first run | runs once per cold start (~30s) |
| Stage 1 download throughput | your home connection | RunPod datacenter (~1 GB/s) |
| Long-running unattended | terminal must stay open | fire-and-forget |
| Per-run cost | $0 | ~$0.01–0.05/hr (CPU pod) |

## What it does

For each invocation:
1. `git clone` (or fast-forward) the JEM repo at the requested ref.
2. Symlink `/app/vendor/asr-training` (pre-built venv) into the cloned repo
   so the script's bootstrap is a no-op.
3. Write `.env` from endpoint secrets (Supabase + HF).
4. Run `bash scripts/build-training-dataset.sh <args>`.
5. Return stdout/stderr tails + the HF dataset URL if Stage 3 ran.

## Build the image

The build context is **this directory**. The image is small and
self-contained — it does not require the JEM repo at build time.

```bash
cd runpod/jem-exporter
docker build -t <your-org>/jem-exporter:latest .
docker push <your-org>/jem-exporter:latest
```

CI builds happen automatically via
[`.github/workflows/build-jem-exporter.yml`](../../.github/workflows/build-jem-exporter.yml)
on every push to `main` that touches `runpod/jem-exporter/`.

## Create the RunPod endpoint

1. RunPod console → **Serverless** → **New Endpoint**.
2. **Container image**: `<your-org>/jem-exporter:latest`
3. **GPU**: not required — pick a CPU pod (cheapest tier).
4. **Worker count**: `Active=0`, `Max=1` is plenty (Stage 1 is sequential).
5. **Idle timeout**: 30s is fine.
6. **Execution timeout**: 1800s (30 min) covers a full library export.
7. **Container disk**: 20 GB (caches MP3s + dataset shards in `/work`).
8. **Network volume**: optional; useful if you want repeat runs to skip the
   `git clone` and reuse `node_modules`. Mount at `/work`.
9. **Environment variables (secrets)**:
   - `SUPABASE_URL` — from your `.env`
   - `SUPABASE_SERVICE_KEY` — service-role JWT (Supabase → Settings → API)
   - `HF_TOKEN` — HuggingFace write token (only required if you push to Hub)

Save the endpoint ID and your RunPod API key — you'll use them to trigger jobs.

## Trigger a job

### From the convenience shim (recommended)

```bash
# One-time:
export RUNPOD_API_KEY=<your-runpod-key>
export RUNPOD_EXPORTER_ENDPOINT=<endpoint-id>

# Smoke test on a single file:
bash scripts/run-export-on-runpod.sh \
  --id a_1013 \
  --push-to-hub ABE101/jem-yi-smoke-2026-04-27

# Full library export:
bash scripts/run-export-on-runpod.sh \
  --library jemedia \
  --push-to-hub ABE101/jem-yi-whisper-$(date +%Y-%m-%d)

# Stage 1 only — produce the per-file folders, skip parquet build:
bash scripts/run-export-on-runpod.sh --library jemedia --stage 1
```

The shim posts to `/run` (async), prints the job id + a `/status/<id>` URL,
and exits. Poll the status URL or check the RunPod dashboard for progress.

### Raw curl

```bash
curl -X POST "https://api.runpod.ai/v2/$RUNPOD_EXPORTER_ENDPOINT/run" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "library_id":  "jemedia",
      "push_to_hub": "ABE101/jem-yi-whisper-2026-04-27"
    }
  }'
```

## Input reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `library_id` | string | (all) | Restrict Stage 1 to one library |
| `audio_id` | string | — | Single-file run; bypasses approved/50hr/benchmark filters |
| `push_to_hub` | string | — | `<org>/<repo>` — runs Stage 3 |
| `stage` | `"1"` \| `"2"` \| `"both"` | `"both"` | Same semantics as the local script |
| `force` | bool | `false` | Re-export Stage 1 even if output exists |
| `resume` | bool | `false` | Skip Stage 1 entries whose output is complete |
| `limit` | int | — | Cap Stage 1 file count (smoke testing) |
| `ref` | string | `main` | JEM git ref to run (branch / tag / sha) |

## Output reference

```jsonc
// success
{
  "status": "completed",
  "stage": "both",
  "library_id": "jemedia",
  "audio_id": null,
  "stdout_tail": "...",
  "dataset_repo": "ABE101/jem-yi-whisper-2026-04-27",
  "dataset_url": "https://huggingface.co/datasets/ABE101/jem-yi-whisper-2026-04-27"
}

// failure (script returned non-zero)
{
  "status": "failed",
  "returncode": 1,
  "error": "build-training-dataset.sh exited with code 1",
  "stderr_tail": "...",
  "stdout_tail": "..."
}

// failure (handler crashed before invoking the script)
{
  "status": "error",
  "error": "...",
  "traceback": "..."
}
```

## Comparison with `runpod/jem-trainer`

| | `jem-exporter` (this) | `jem-trainer` |
|---|---|---|
| Purpose | Build the dataset | Fine-tune the model |
| GPU | not required | required (A100/H100) |
| Base image | `python:3.12-slim` | `pytorch/pytorch:2.4.0-cuda12.4` |
| Wraps | `scripts/build-training-dataset.sh` | `train-whisper.py` |
| Typical runtime | 5–30 min | 1–24 hr |

These two pods compose: the exporter produces a HF dataset; the trainer
consumes it via `HF_DATASET_REPO`.
