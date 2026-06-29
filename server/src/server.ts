import express from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { STREAM_PATH, type MarketsResponse, type StreamMessage } from '@shared';
import type { DataSource } from './datasource/index.js';
import { config } from './config.js';

/**
 * Thin transport over a DataSource (spec §6.3, D1): REST snapshots + a WS
 * stream. The frontend renders purely off these and never touches the chain,
 * subgraph, or Bybit directly.
 */
export function startServer(source: DataSource): Server {
  const app = express();
  app.use(cors());

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

  app.get('/api/quotes', (_req, res) => res.json(source.getQuotes()));
  app.get('/api/fills', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 400, 1000);
    res.json(source.getFills().slice(-limit));
  });
  app.get('/api/volume', (_req, res) => {
    // both scopes are carried per-row (cloberVenue / cloberVault); the client
    // selects. The query param is accepted for spec parity.
    res.json(source.getVolume());
  });

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

  httpServer.listen(config.port, () => {
    console.log(`[mpamm] ${source.mode} source · http://localhost:${config.port} · ws ${STREAM_PATH}`);
  });

  httpServer.on('close', () => source.off('message', onMessage));
  return httpServer;
}

function safeSend(ws: WebSocket, m: StreamMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}
