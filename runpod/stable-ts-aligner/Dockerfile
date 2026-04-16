FROM pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime

# Install ffmpeg (required by stable-ts for audio decoding/seeking)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Whisper model during build so cold starts only need GPU init
# Pre-download the Yiddish-tuned Whisper model (CTranslate2 format)
# Override at runtime with MODEL_NAME env var (e.g., ivrit-ai/yi-whisper-large-v3-ct2 for full model)
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('ivrit-ai/yi-whisper-large-v3-turbo-ct2', device='cpu', compute_type='int8')"

# Copy handler code
COPY . .

# RunPod serverless entry point
CMD ["python", "-u", "handler.py"]
