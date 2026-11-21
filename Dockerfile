FROM node:20-slim

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Install system dependencies, ffmpeg, python3, and yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
