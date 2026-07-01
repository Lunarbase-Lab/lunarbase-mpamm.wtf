import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MarketState, QuoteSnapshot, QuoteRow, Fill, DailyVolume, Venue } from '@shared';
import { fetchMarkets, fetchFills, connectStream } from './lib/api';

export const VENUES: Venue[] = ['LFJ', 'Clober', 'Vault', 'Bybit'];
export type Tab = 'exec' | 'volume' | 'markouts' | 'leaderboard';
const N = 120; // canvas rolling window (≈60s @ 500ms)

export interface Series { bid: number[]; ask: number[]; }

interface UiState {
  tab: Tab;
  pair: string;
  size: number;
  venues: Record<Venue, boolean>;
  clScope: 'venue' | 'vault';
  // markouts
  mkProto: string; mkSide: string; mkSize: string; mkPaused: boolean;
  // leaderboard
  lbWin: string; lbShow: string; lbGroup: string; lbHz: string; lbMk: string; lbWinners: boolean; lbTop: number;
}

interface Dashboard extends UiState {
  conn: 'connecting' | 'live' | 'reconnecting';
  state: MarketState | null;
  quotes: QuoteSnapshot | null;
  volume: DailyVolume[];
  fills: Fill[];
  frame: number;
  series: Record<Venue, Series>;
  samples: Record<Venue, number[]>;
  // setters
  set: <K extends keyof UiState>(k: K, v: UiState[K]) => void;
  toggleVenue: (v: Venue) => void;
  resetLb: () => void;
}

const Ctx = createContext<Dashboard | null>(null);
export const useDashboard = (): Dashboard => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDashboard outside provider');
  return c;
};

const emptySeries = (): Record<Venue, Series> => {
  const o = {} as Record<Venue, Series>;
  for (const v of VENUES) o[v] = { bid: [], ask: [] };
  return o;
};
const emptySamples = (): Record<Venue, number[]> => {
  const o = {} as Record<Venue, number[]>;
  for (const v of VENUES) o[v] = [];
  return o;
};

function rowFor(q: QuoteSnapshot | null, venue: Venue, market: string, size: number): QuoteRow | undefined {
  return q?.rows.find((r) => r.venue === venue && r.market === market && r.sizeUsd === size);
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>({
    tab: 'exec', pair: 'MON/USDC', size: 1000,
    venues: { LFJ: true, Clober: true, Vault: true, Bybit: true },
    clScope: 'venue',
    mkProto: 'ALL', mkSide: 'ALL', mkSize: 'ANY', mkPaused: false,
    lbWin: '24H', lbShow: 'PROPAMM', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'TAKER', lbWinners: true, lbTop: 25,
  });
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [state, setState] = useState<MarketState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSnapshot | null>(null);
  const [volume, setVolume] = useState<DailyVolume[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [frame, setFrame] = useState(0);

  const seriesRef = useRef<Record<Venue, Series>>(emptySeries());
  const samplesRef = useRef<Record<Venue, number[]>>(emptySamples());
  const quotesRef = useRef<QuoteSnapshot | null>(null);
  const selRef = useRef({ pair: ui.pair, size: ui.size });
  selRef.current = { pair: ui.pair, size: ui.size };

  const pushSnapshot = (q: QuoteSnapshot) => {
    quotesRef.current = q;
    const { pair, size } = selRef.current;
    for (const v of VENUES) {
      const r = rowFor(q, v, pair, size);
      if (!r) continue;
      // push each side independently: a one-sided quote (thin/backstop other
      // side, px 0) contributes only its real line — never a 0 that would wreck
      // the canvas price scale, and never a phantom spread into the percentiles.
      const s = seriesRef.current[v];
      if (r.bidPx > 0) { s.bid.push(r.bidPx); if (s.bid.length > N) s.bid.shift(); }
      if (r.askPx > 0) { s.ask.push(r.askPx); if (s.ask.length > N) s.ask.shift(); }
      if (!r.oneSided && r.bidPx > 0 && r.askPx > 0) {
        const smp = samplesRef.current[v];
        smp.push(r.spreadBps);
        if (smp.length > 600) smp.shift();
      }
    }
  };

  // reseed the canvas buffers from the current matrix so a freshly-selected
  // pair/size renders a full chart immediately (DCLogic.reseedQuotes).
  const reseed = () => {
    const q = quotesRef.current;
    const next = emptySeries();
    if (q) {
      const { pair, size } = selRef.current;
      for (const v of VENUES) {
        const r = rowFor(q, v, pair, size);
        if (!r) continue;
        for (let i = 0; i < N; i++) {
          const j = 1 + (Math.random() * 2 - 1) * 0.0008;
          if (r.bidPx > 0) next[v].bid.push(r.bidPx * j);
          if (r.askPx > 0) next[v].ask.push(r.askPx * j);
        }
      }
    }
    seriesRef.current = next;
    samplesRef.current = emptySamples();
  };

  // cold start + stream. The snapshot is (re)loaded both on mount and on every
  // WS (re)connect, so an initial fetch that races a backend restart is healed,
  // and a reconnect re-syncs history/fills (spec §8 replay).
  useEffect(() => {
    const mounted = { v: true };
    const loadSnapshot = async () => {
      try {
        // markets snapshot + the persisted historical fills window (the tape /
        // markouts / leaderboard operate on real history, not a live buffer).
        const [m, hist] = await Promise.all([
          fetchMarkets(),
          fetchFills(30, 20000).catch(() => null),
        ]);
        if (!mounted.v) return;
        setState(m.state); setQuotes(m.quotes); setVolume(m.volume);
        // /api/fills is newest-first; store oldest-first so the cap in
        // upsertFill drops the genuine oldest, not the newest (audit B4).
        setFills(hist && hist.length ? [...hist].reverse() : m.fills);
        quotesRef.current = m.quotes;
        reseed();
        setFrame((f) => f + 1);
      } catch { /* retried on the next WS connect */ }
    };
    loadSnapshot();

    const dispose = connectStream((msg) => {
      if (msg.ch === 'state') setState(msg.data);
      else if (msg.ch === 'quotes') { setQuotes(msg.data); pushSnapshot(msg.data); setFrame((f) => f + 1); }
      else if (msg.ch === 'volume') setVolume((prev) => mergeDay(prev, msg.data));
      else if (msg.ch === 'fill') setFills((prev) => upsertFill(prev, msg.data));
    }, (s) => { setConn(s); if (s === 'live') loadSnapshot(); });

    return () => { mounted.v = false; dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reseed when the selected pair/size changes
  useEffect(() => { reseed(); setFrame((f) => f + 1); /* eslint-disable-next-line */ }, [ui.pair, ui.size]);

  const api = useMemo<Dashboard>(() => ({
    ...ui, conn, state, quotes, volume, fills, frame,
    series: seriesRef.current, samples: samplesRef.current,
    set: (k, v) => setUi((s) => ({ ...s, [k]: v })),
    toggleVenue: (v) => setUi((s) => ({ ...s, venues: { ...s.venues, [v]: !s.venues[v] } })),
    resetLb: () => setUi((s) => ({ ...s, lbWin: '24H', lbShow: 'PROPAMM', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'TAKER', lbWinners: true, lbTop: 25 })),
  }), [ui, conn, state, quotes, volume, fills, frame]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

function mergeDay(days: DailyVolume[], d: DailyVolume): DailyVolume[] {
  const i = days.findIndex((x) => x.utcDay === d.utcDay);
  if (i === -1) return [...days, d];
  const next = days.slice();
  next[i] = d;
  return next;
}

function upsertFill(fills: Fill[], f: Fill): Fill[] {
  const i = fills.findIndex((x) => x.id === f.id);
  if (i !== -1) {
    const next = fills.slice();
    next[i] = f;
    return next;
  }
  const next = [...fills, f];
  if (next.length > 50000) next.shift();
  return next;
}
