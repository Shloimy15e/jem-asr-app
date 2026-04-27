# JEM dataset export serverless worker — wraps `scripts/build-training-dataset.sh`
# from the JEM repo so Stage 1 (Node) + Stage 2 (Python create_dataset.py) +
# optional Stage 3 (push to HF Hub) all run unattended on RunPod.
#
# Self-contained build: build context is THIS directory. Works with any CI
# builder.
#
#   cd runpod/jem-exporter
#   docker build -t jem-exporter:latest .
#
# Why CPU base (not the trainer's CUDA image): Stage 1 is pure I/O + MP3
# byte-slicing; Stage 2's create_dataset.py is CPU-bound segment packing.
# Neither needs a GPU. Cheaper pod.

FROM python:3.12-slim

# Node 20, ffmpeg, libsndfile, git
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates ffmpeg libsndfile1 git && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Pre-clone ivrit-ai/asr-training (the heavy bootstrap step) ──
# build-training-dataset.sh expects this at <repo>/vendor/asr-training/.
# We bake it once at /app/vendor/asr-training and the handler symlinks it
# into the cloned JEM repo's vendor/ at runtime, skipping the script's
# bootstrap entirely.
ARG IVRIT_REF=master
RUN git clone --depth 1 --branch ${IVRIT_REF} \
    https://github.com/ivrit-ai/asr-training /app/vendor/asr-training

# ── Pre-build the Python venv with the same pinned deps the script
#    installs on first run, so the bootstrap import-check passes and we
#    skip the ~5 minute pip install on every cold start ──
RUN python3 -m venv /app/vendor/asr-training/.venv && \
    /app/vendor/asr-training/.venv/bin/pip install --no-cache-dir --upgrade pip && \
    /app/vendor/asr-training/.venv/bin/pip install --no-cache-dir \
        'stable-ts' \
        'av>=12.3.0,<14' \
        'audiosample==2.2.6' \
        'datasets<4.0.0' \
        'huggingface_hub' \
        'soundfile' \
        'tqdm' \
        'numpy' \
        'requests' \
        'runpod'

COPY handler.py /app/handler.py

# Workspace where the JEM repo gets cloned at runtime
RUN mkdir -p /work
ENV JEM_REPO=https://github.com/Abe1018776/jem-asr-app.git \
    JEM_REF=main \
    JEM_WORK_DIR=/work/jem-asr-app

# Use the pre-built venv's Python so `import runpod` resolves
CMD ["/app/vendor/asr-training/.venv/bin/python", "-u", "/app/handler.py"]
