import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MarketState, QuoteSnapshot, QuoteRow, Fill, DailyVolume, VenueMeta } from '@shared';
import { pairOf, cexForBase } from '@shared';
import { fetchMarkets, fetchFills, fetchQuoteHistory, connectStream } from './lib/api';
import type { Theme } from './theme';

/** Read the persisted theme, matching the pre-paint script in index.html.
 *  Default is dark; only an explicit 'light' choice opts out. */
const initialTheme = (): Theme => {
  try { return localStorage.getItem('pamm-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
};
export type Tab = 'exec' | 'volume' | 'markouts' | 'leaderboard';
const N = 120; // canvas rolling window (≈60s @ 500ms)

export interface Series { bid: number[]; ask: number[]; }

interface UiState {
  tab: Tab;
  theme: Theme;
  pair: string;
  size: number;
  // per-venue on/off, keyed by VenueMeta.id. Defaults all registry venues on so
  // the reference benchmark still renders when no propAMM venue has a quote.
  venueToggles: Record<string, boolean>;
  // markouts
  mkProto: string; mkSide: string; mkSize: string; mkPaused: boolean;
  // leaderboard
  lbWin: string; lbGroup: string; lbHz: string; lbMk: string; lbWinners: boolean; lbTop: number;
}

interface Dashboard extends UiState {
  conn: 'connecting' | 'live' | 'reconnecting';
  state: MarketState | null;
  quotes: QuoteSnapshot | null;
  volume: DailyVolume[];
  fills: Fill[];
  frame: number;
  // venue registry (from state.venues) + derived views. Everything venue-related
  // in the UI reads these; nothing about a venue is hardcoded client-side.
  venues: VenueMeta[];
  displayVenues: VenueMeta[];              // role === 'venue' (propAMM makers)
  reference: VenueMeta | undefined;        // default CEX benchmark (first reference)
  references: VenueMeta[];                  // all CEX benchmarks (role === 'reference')
  /** the CEX benchmark for a market, routed by base asset (Bybit for MON, Binance for BTC/ETH). */
  referenceFor: (market: string) => VenueMeta | undefined;
  venuesById: Record<string, VenueMeta>;
  series: Record<string, Series>;
  samples: Record<string, number[]>;
  // setters
  set: <K extends keyof UiState>(k: K, v: UiState[K]) => void;
  toggleVenue: (id: string) => void;
  toggleTheme: () => void;
  resetLb: () => void;
}

const Ctx = createContext<Dashboard | null>(null);
export const useDashboard = (): Dashboard => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDashboard outside provider');
  return c;
};

/** venue ids carried by the current registry — drives the per-venue buffers. */
const venueIds = (state: MarketState | null): string[] => (state?.venues ?? []).map((v) => v.id);

function rowFor(q: QuoteSnapshot | null, venueId: string, market: string, size: number): QuoteRow | undefined {
  return q?.rows.find((r) => r.venueId === venueId && r.market === market && r.sizeUsd === size);
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>({
    tab: 'exec', theme: initialTheme(), pair: 'MON/USDC', size: 100,
    venueToggles: {},
    mkProto: 'ALL', mkSide: 'ALL', mkSize: 'ANY', mkPaused: false,
    lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'TAKER', lbWinners: true, lbTop: 25,
  });
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [state, setState] = useState<MarketState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSnapshot | null>(null);
  const [volume, setVolume] = useState<DailyVolume[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [frame, setFrame] = useState(0);

  const seriesRef = useRef<Record<string, Series>>({});
  const samplesRef = useRef<Record<string, number[]>>({});
  const quotesRef = useRef<QuoteSnapshot | null>(null);
  // the venue ids the buffers are keyed by — read inside the (stable) stream
  // callback so we never close over a stale registry.
  const idsRef = useRef<string[]>([]);
  const selRef = useRef({ pair: ui.pair, size: ui.size });
  selRef.current = { pair: ui.pair, size: ui.size };
  // what the buffers currently CONTAIN ("pair|size"). pushSnapshot re-keys
  // synchronously on mismatch, so a WS tick arriving between a pair switch and
  // the reseed effect can never append new-pair prices onto old-pair samples
  // (the mixed-buffer scale flicker).
  const seedKeyRef = useRef('');
  const seedFetchRef = useRef(''); // key with a history fetch in flight (dedupe)
  const keyOf = () => `${selRef.current.pair}|${selRef.current.size}`;

  const pushSnapshot = (q: QuoteSnapshot) => {
    quotesRef.current = q;
    if (seedKeyRef.current !== keyOf()) reseed(); // sync re-key — mixed buffers impossible
    const { pair, size } = selRef.current;
    for (const id of idsRef.current) {
      const r = rowFor(q, id, pair, size);
      if (!r) continue;
      // push each side independently: a one-sided quote (thin/backstop other
      // side, px 0) contributes only its real line — never a 0 that would wreck
      // the canvas price scale, and never a phantom spread into the percentiles.
      const s = (seriesRef.current[id] ??= { bid: [], ask: [] });
      if (r.bidPx > 0) { s.bid.push(r.bidPx); if (s.bid.length > N) s.bid.shift(); }
      if (r.askPx > 0) { s.ask.push(r.askPx); if (s.ask.length > N) s.ask.shift(); }
      // only a real, full-size two-sided quote feeds the spread distribution —
      // a partial (size-exhausted, filledFull=false) or one-sided quote is not
      // executable at the requested notional, so it must not skew the stats.
      if (!r.oneSided && r.filledFull && r.bidPx > 0 && r.askPx > 0) {
        const smp = (samplesRef.current[id] ??= []);
        smp.push(r.spreadBps);
        if (smp.length > 600) smp.shift();
      }
    }
  };

  // reseed the canvas buffers for the current pair/size: clear + a flat pre-fill
  // from the current matrix as an instant fallback, then replace it with the
  // server's REAL last-60s quote history as soon as it arrives (so the chart
  // never fabricates a flat minute — user feedback).
  const reseed = () => {
    const q = quotesRef.current;
    const ids = idsRef.current;
    seedKeyRef.current = keyOf();
    // Mutate the buffers IN PLACE (keep the seriesRef/samplesRef object references
    // stable) so `d.series` — captured in the api memo — can never point at a stale
    // pre-reseed object. Clear every buffer, drop de-registered venues, then refill.
    const S = seriesRef.current, SM = samplesRef.current;
    for (const id of ids) { const s = (S[id] ??= { bid: [], ask: [] }); s.bid.length = 0; s.ask.length = 0; (SM[id] ??= []).length = 0; }
    for (const id of Object.keys(S)) if (!ids.includes(id)) delete S[id];
    for (const id of Object.keys(SM)) if (!ids.includes(id)) delete SM[id];
    if (q) {
      const { pair, size } = selRef.current;
      for (const id of ids) {
        const r = rowFor(q, id, pair, size);
        if (!r) continue;
        for (let i = 0; i < N; i++) {
          // flat pre-fill fallback (no jitter) — holds the scale correct until the
          // real history lands; real streaming quotes step it (no smoothing).
          if (r.bidPx > 0) S[id].bid.push(r.bidPx);
          if (r.askPx > 0) S[id].ask.push(r.askPx);
        }
      }
    }
    void seedFromHistory(seedKeyRef.current);
  };

  // replace the flat pre-fill with the server's retained real quote ticks for
  // this (pair, size). Stale-guarded: a slow response for a pair the user has
  // already left is discarded (seedKey moved on).
  const seedFromHistory = async (key: string) => {
    if (seedFetchRef.current === key) return; // already fetching this key
    seedFetchRef.current = key;
    try {
      const [pair, sizeS] = key.split('|');
      const hist = await fetchQuoteHistory(pair, Number(sizeS));
      if (seedKeyRef.current !== key || !hist.length) return;
      const ids = new Set(idsRef.current);
      const S = seriesRef.current, SM = samplesRef.current;
      for (const id of idsRef.current) { const s = (S[id] ??= { bid: [], ask: [] }); s.bid.length = 0; s.ask.length = 0; (SM[id] ??= []).length = 0; }
      for (const q of hist) {
        for (const r of q.rows) {
          if (!ids.has(r.venueId)) continue;
          const s = (S[r.venueId] ??= { bid: [], ask: [] });
          if (r.bidPx > 0) { s.bid.push(r.bidPx); if (s.bid.length > N) s.bid.shift(); }
          if (r.askPx > 0) { s.ask.push(r.askPx); if (s.ask.length > N) s.ask.shift(); }
          if (!r.oneSided && r.filledFull && r.bidPx > 0 && r.askPx > 0) {
            const smp = (SM[r.venueId] ??= []);
            smp.push(r.spreadBps);
            if (smp.length > 600) smp.shift();
          }
        }
      }
      // The canvas indexes left→right with "now" at the right edge, so a short
      // ring (young server) must be LEFT-padded to the window: hold the earliest
      // observed value flat into the unobserved past, real data ends at now.
      for (const id of idsRef.current) {
        const s = S[id];
        if (s.bid.length && s.bid.length < N) s.bid.unshift(...Array(N - s.bid.length).fill(s.bid[0]));
        if (s.ask.length && s.ask.length < N) s.ask.unshift(...Array(N - s.ask.length).fill(s.ask[0]));
      }
      setFrame((f) => f + 1);
    } catch { /* flat pre-fill stays — the stream still steps it live */ }
    finally { if (seedFetchRef.current === key) seedFetchRef.current = ''; }
  };

  // adopt a fresh registry: re-key the per-venue buffers and default a toggle for
  // every registry venue to on the first time we see it. Called on the initial
  // snapshot and on every `state` stream message, so venues that
  // appear/disappear at runtime are handled without hardcoding.
  const adoptVenues = (venues: VenueMeta[]) => {
    idsRef.current = venues.map((v) => v.id);
    setUi((s) => {
      const next = { ...s.venueToggles };
      let changed = false;
      for (const v of venues) {
        if (!(v.id in next)) { next[v.id] = true; changed = true; }
      }
      return changed ? { ...s, venueToggles: next } : s;
    });
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
        adoptVenues(m.state.venues ?? []);
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
      if (msg.ch === 'state') { setState(msg.data); adoptVenues(msg.data.venues ?? []); }
      else if (msg.ch === 'quotes') { setQuotes(msg.data); pushSnapshot(msg.data); setFrame((f) => f + 1); }
      else if (msg.ch === 'volume') setVolume((prev) => mergeDay(prev, msg.data));
      else if (msg.ch === 'fill') setFills((prev) => upsertFill(prev, msg.data));
    }, (s) => { setConn(s); if (s === 'live') loadSnapshot(); });

    return () => { mounted.v = false; dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reseed when the selected pair/size changes
  useEffect(() => { reseed(); setFrame((f) => f + 1); /* eslint-disable-next-line */ }, [ui.pair, ui.size]);
  // reseed when the venue registry changes (ids added/removed) so the buffers are
  // re-keyed and pre-filled for the new set before the next stream tick.
  useEffect(() => { reseed(); setFrame((f) => f + 1); /* eslint-disable-next-line */ }, [venueIds(state).join(',')]);

  const venues = state?.venues ?? [];
  const { displayVenues, references, reference, venuesById } = useMemo(() => {
    const byId: Record<string, VenueMeta> = {};
    for (const v of venues) byId[v.id] = v;
    const refs = venues.filter((v) => v.role === 'reference');
    return {
      displayVenues: venues.filter((v) => v.role === 'venue'),
      references: refs,
      reference: refs[0],
      venuesById: byId,
    };
  }, [venues]);
  // the CEX benchmark for a market, routed by base asset (Bybit for MON, Binance for BTC/ETH).
  const referenceFor = useMemo(() => (market: string): VenueMeta | undefined => {
    const base = pairOf(market)?.base;
    return base ? venuesById[cexForBase(base)] : reference;
  }, [venuesById, reference]);

  const api = useMemo<Dashboard>(() => ({
    ...ui, conn, state, quotes, volume, fills, frame,
    venues, displayVenues, reference, references, referenceFor, venuesById,
    series: seriesRef.current, samples: samplesRef.current,
    set: (k, v) => setUi((s) => ({ ...s, [k]: v })),
    toggleVenue: (id) => setUi((s) => ({ ...s, venueToggles: { ...s.venueToggles, [id]: !s.venueToggles[id] } })),
    toggleTheme: () => {
      const theme: Theme = ui.theme === 'dark' ? 'light' : 'dark';
      // Side effects in the handler — NOT the state updater, which React may
      // defer or double-invoke. Set the html attr so the DOM re-skins instantly
      // via CSS vars, and persist the choice.
      try { localStorage.setItem('pamm-theme', theme); } catch { /* private mode */ }
      document.documentElement.dataset.theme = theme;
      setUi((s) => ({ ...s, theme }));
      // canvas colors come from JS getters (not var()), so force a repaint.
      setFrame((f) => f + 1);
    },
    resetLb: () => setUi((s) => ({ ...s, lbWin: '24H', lbGroup: 'PROTOCOL', lbHz: 'T+0S', lbMk: 'TAKER', lbWinners: true, lbTop: 25 })),
  }), [ui, conn, state, quotes, volume, fills, frame, venues, displayVenues, reference, references, referenceFor, venuesById]);

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
