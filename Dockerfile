# pivx402payment cat demo — explorer-backed, no local pivxd.
#
# Serves /cat behind HTTP 402 Payment Required, verifying payments through a
# BlockBook-compatible PIVX explorer. Set PIVX_PAY_TO + PIVX_NETWORK + PRICE_PIV
# in the environment (typically via docker compose env_file).
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App source.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY demo ./demo

# Default to mainnet + the public PIVX BlockBook explorer. Override via env.
ENV NODE_ENV=production
ENV PIVX_NETWORK=mainnet
ENV PIVX_EXPLORER_URL=https://explorer.duddino.com
ENV PRICE_PIV=0.0001
ENV MIN_CONFIRMATIONS=1
ENV SCHEME=pivx-transparent
ENV PORT=4403

# Drop privileges — node:20-bookworm-slim ships a non-root `node` user.
USER node

EXPOSE 4403

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4403/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "--no-install", "tsx", "demo/cat.ts"]
