import type { MarketsResponse, StreamMessage, Fill, QuoteSnapshot } from '@shared';

export async function fetchMarkets(): Promise<MarketsResponse> {
  const r = await fetch('/api/markets');
  if (!r.ok) throw new Error(`/api/markets ${r.status}`);
  return r.json();
}

/** The last ~60s of real quote ticks for one (market, size) — seeds the
 *  Execution chart so it shows real history instead of a flat pre-fill. */
export async function fetchQuoteHistory(market: string, size: number): Promise<QuoteSnapshot[]> {
  const r = await fetch(`/api/quotes/history?market=${encodeURIComponent(market)}&size=${size}`);
  if (!r.ok) throw new Error(`/api/quotes/history ${r.status}`);
  return r.json();
}

/** Historical fills window (persisted) for the tape / markouts / leaderboard. */
export async function fetchFills(days = 30, limit = 20000): Promise<Fill[]> {
  const r = await fetch(`/api/fills?days=${days}&limit=${limit}`);
  if (!r.ok) throw new Error(`/api/fills ${r.status}`);
  return r.json();
}

/** Reconnecting WS to the service stream. Returns a disposer. */
export function connectStream(
  onMsg: (m: StreamMessage) => void,
  onState: (s: 'live' | 'reconnecting') => void,
): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => onState('live');
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data) as StreamMessage); } catch { /* ignore */ } };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      if (closed) return;
      onState('reconnecting');
      timer = setTimeout(open, 1000);
    };
  };
  open();

  return () => { closed = true; if (timer) clearTimeout(timer); ws?.close(); };
}
