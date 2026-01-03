FROM node:22-bookworm-slim

WORKDIR /app

# System deps for:
# - ffmpeg video editing
# - python/pip for local Whisper + optional OpenCV (installed on-demand by the app)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install node deps first (better Docker cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Fly runs on 8080 by default; we still honor PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["node","server.js"]


