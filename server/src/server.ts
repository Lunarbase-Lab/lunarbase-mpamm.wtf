import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { STREAM_PATH, type MarketsResponse, type StreamMessage } from '@shared';
import type { DataSource } from './datasource/index.js';
import { config } from './config.js';
import { venueMeta } from './venues/registry.js';

/**
 * Thin transport over a DataSource (spec §6.3, D1): REST snapshots + a WS
 * stream. The frontend renders purely off these and never touches the chain,
 * subgraph, or Bybit directly.
 */
export function startServer(source: DataSource): Server {
  const app = express();
  app.use(cors());

  // HSTS (production only): once a browser has seen this over HTTPS, it forces
  // HTTPS for a year — including subdomains (www.*) — so there's no plain-http
  // hop to cache as "not secure". Guarded by NODE_ENV so it never pins localhost
  // in dev; TLS is terminated at Render's edge, which only serves us over HTTPS.
  // No `preload` directive — that's a separate, hard-to-reverse hstspreload.org opt-in.
  if (process.env.NODE_ENV === 'production') {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, source: source.mode, block: source.getState().block });
  });

  app.get('/api/markets', (_req, res) => {
    const body: MarketsResponse = {
      state: source.getState(),
      quotes: source.getQuotes(),
      fills: source.getFills(),
      volume: source.getVolume(),
    };
    res.json(body);
  });

  // the venue registry (adapters + CEX reference) — id/name/color/kind/role.
  // The frontend also gets this inside /api/markets state.venues; this is a
  // standalone endpoint for external consumers.
  app.get('/api/venues', (_req, res) => res.json(venueMeta()));

  app.get('/api/quotes', (_req, res) => res.json(source.getQuotes()));
  app.get('/api/fills', (req, res) => {
    // ?days=N → last N days (from the persisted store); ?limit caps the count.
    const days = positiveNumberParam(req.query.days);
    const sinceMs = days === undefined ? undefined : Date.now() - days * 86_400_000;
    const requestedLimit = positiveNumberParam(req.query.limit);
    const limit = Math.min(Math.floor(requestedLimit ?? 1000), 50_000);
    res.json(source.queryFills({ sinceMs, limit }));
  });
  app.get('/api/volume', (req, res) => {
    // honor ?from=&to= (YYYY-MM-DD, lexicographic). Both scope columns
    // (cloberVenue / cloberVault) are carried per row and the client selects, so
    // ?scope is accepted but informational (audit I7).
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    let days = source.getVolume();
    if (from) days = days.filter((d) => d.utcDay >= from);
    if (to) days = days.filter((d) => d.utcDay <= to);
    res.json(days);
  });

  // Production single-service: serve the built frontend same-origin (so the
  // relative /api + /stream URLs just work). Skipped in dev (Vite serves it).
  if (config.webDist && existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === STREAM_PATH) return next();
      res.sendFile(join(config.webDist, 'index.html'));
    });
    console.log(`[mpamm] serving frontend from ${config.webDist}`);
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: STREAM_PATH });

  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    // hello with current state so a client can render before the next tick
    safeSend(ws, { ch: 'state', data: source.getState() });
    safeSend(ws, { ch: 'quotes', data: source.getQuotes() });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const onMessage = (m: StreamMessage) => {
    const payload = JSON.stringify(m);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };
  source.on('message', onMessage);

  // Fail cleanly on a listen error (e.g. another instance already on this port)
  // instead of crashing with an unhandled 'error' event.
  const onFatal = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[mpamm] API_PORT ${config.port} is already in use — another instance is running, or set API_PORT to a free port.`);
    } else {
      console.error('[mpamm] server error:', err.message);
    }
    process.exit(1);
  };
  httpServer.on('error', onFatal);
  wss.on('error', onFatal);

  httpServer.listen(config.port, () => {
    console.log(`[mpamm] ${source.mode} source · http://localhost:${config.port} · ws ${STREAM_PATH}`);
  });

  httpServer.on('close', () => source.off('message', onMessage));
  return httpServer;
}

function safeSend(ws: WebSocket, m: StreamMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function positiveNumberParam(v: unknown): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
