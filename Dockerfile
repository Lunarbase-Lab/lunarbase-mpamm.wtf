# syntax=docker/dockerfile:1
#
# Single-service image: one Node process serves the REST/WS API AND the built
# frontend (same origin), so the SPA's relative /api + /stream URLs just work.

# ── build: install workspace deps + build the frontend ──────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm -w web run build

# ── runtime: serve API/WS + the built frontend (run TS directly via tsx) ─────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WEB_DIST=/app/web/dist
ENV DB_PATH=/data/mpamm.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/dist ./web/dist
# Persist the SQLite history across deploys (mount a volume at /data).
VOLUME ["/data"]
EXPOSE 8787
# Railway (and most PaaS) inject $PORT; map it to API_PORT (8787 locally).
CMD ["sh", "-c", "API_PORT=${PORT:-8787} npm -w server run start"]
