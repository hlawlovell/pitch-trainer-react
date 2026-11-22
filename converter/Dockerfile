# YouTube -> UltraStar converter: a small job API around UltraSinger (CPU only).
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git build-essential curl \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

# UltraSinger, pinned so a change upstream can't silently break conversions
ARG ULTRASINGER_REF=e94d94246042e48214286a0e144a4bd25832e60e
RUN git clone https://github.com/rakuri255/UltraSinger.git /opt/UltraSinger \
    && git -C /opt/UltraSinger checkout ${ULTRASINGER_REF}
WORKDIR /opt/UltraSinger
# Exactly the versions in UltraSinger's lockfile (newer ones have broken APIs, e.g. swift-f0 0.3),
# except PyTorch, which comes as the CPU build (skips ~3 GB of NVIDIA libraries).
RUN uv export --frozen --no-hashes --no-emit-project --extra linux -o /tmp/req.txt \
    && grep -v -E '^(torch|torchaudio|torchvision|triton)[=<> ;]|^nvidia-' /tmp/req.txt > /tmp/req-cpu.txt \
    && uv pip install --system torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 \
       --index-url https://download.pytorch.org/whl/cpu \
    && uv pip install --system -r /tmp/req-cpu.txt \
    && uv pip install --system --no-deps -e . \
    && python -c "import torch; assert not torch.version.cuda, 'CUDA torch got installed'"
# Don't snap notes to the detected key: a wrong key guess moves correct notes a semitone
# (The Reason, in E major, was detected as F# minor and lost every D#). Its CLI flag for this is broken,
# so change the default. Also skip the MIDI file, which the app doesn't use.
RUN sed -i -e 's/^\(\s*quantize_to_key\s*=\s*\)True/\1False/' -e 's/^\(\s*create_midi\s*=\s*\)True/\1False/' src/Settings.py \
    && grep -q 'quantize_to_key = False' src/Settings.py && grep -q 'create_midi = False' src/Settings.py
# yt-dlp has to keep up with YouTube, so it's the one thing installed at its latest version
RUN uv pip install --system -U "yt-dlp[default]"
# Chinese lyrics: simplified characters (pure-Python OpenCC) and word boundaries for line breaks (jieba)
RUN uv pip install --system opencc-python-reimplemented==0.1.7 jieba==0.42.1

# models (Whisper, Demucs, ...) are downloaded on first use into this volume
ENV HF_HOME=/models/hf TORCH_HOME=/models/torch XDG_CACHE_HOME=/models/cache \
    PYTHONUNBUFFERED=1 CUDA_VISIBLE_DEVICES=-1
COPY server.py /app/server.py
EXPOSE 8000
CMD ["python", "/app/server.py"]
