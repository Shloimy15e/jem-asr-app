FROM pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Yiddish-tuned Whisper model during build so cold starts
# only pay for GPU init, not model download.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('ivrit-ai/yi-whisper-large-v3-turbo-ct2', device='cpu', compute_type='int8')"

COPY alignment/ ./alignment/
COPY download_audio.py aligner.py handler.py ./

ENV AUDIO_DOWNLOAD_DIR=/tmp/ivrit-audio
RUN mkdir -p /tmp/ivrit-audio

CMD ["python", "-u", "handler.py"]
