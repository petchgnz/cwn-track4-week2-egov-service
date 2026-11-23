# e-Service กลาง (B01) — Node.js 20 + Express + better-sqlite3, server-side rendered
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Bangkok \
    PORT=3005 \
    DB_PATH=/data/egov.db

# build tools only in case the better-sqlite3 prebuilt binary cannot be downloaded
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) \
 && npm cache clean --force

COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3005)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
