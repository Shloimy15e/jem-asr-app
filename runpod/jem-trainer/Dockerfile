# JEM Whisper fine-tuning serverless worker — thin wrapper around ivrit-ai's
# train-whisper.py.
#
# Self-contained: build context is THIS directory. Works with any CI builder
# (RunPod GitHub integration, docker build here, GitHub Actions, etc.).
#
#   cd runpod/jem-trainer
#   docker build -t jem-trainer:latest .

FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Clone ivrit-ai at build time (cold starts don't re-clone) ──
ARG IVRIT_REF=main
RUN git clone --depth 1 --branch ${IVRIT_REF} \
    https://github.com/ivrit-ai/asr-training /app/asr-training

# ── Install ivrit-ai's pinned deps + runpod SDK + wandb ──
RUN pip install --no-cache-dir -r /app/asr-training/requirements.txt && \
    pip install --no-cache-dir runpod wandb

# ── Copy configs + handler (paths relative to build context = this dir) ──
COPY configs /app/configs
COPY handler.py /app/handler.py

# HF cache on the same volume the pod uses for workspace
ENV HF_HOME=/app/.cache/huggingface
ENV TRANSFORMERS_CACHE=/app/.cache/huggingface
RUN mkdir -p /app/.cache/huggingface

CMD ["python", "-u", "handler.py"]
