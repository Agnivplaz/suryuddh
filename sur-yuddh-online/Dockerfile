# Sur Yuddh — one container serving the game + REST API + WebSocket relay.
# Build context is the PROJECT ROOT (so client/ ships with the server).
FROM node:20-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PUBLIC_DIR=/app/client

WORKDIR /app

# dependencies first (better layer caching)
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

# application + the game itself
COPY server/ ./server/
COPY client/ ./client/

# SQLite fallback needs a writable directory; Postgres deployments ignore it
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
