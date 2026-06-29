import { useEffect, useState } from 'react';
import { C, SANS } from '../theme';
import { useDashboard, type Tab } from '../store';
import { clockSec, fmtInt } from '../lib/format';

const TABS: { id: Tab; label: string }[] = [
  { id: 'exec', label: 'EXECUTION' },
  { id: 'volume', label: 'VOLUME' },
  { id: 'markouts', label: 'MARKOUTS' },
  { id: 'leaderboard', label: 'LEADERBOARD' },
];

export function TopBar() {
  const d = useDashboard();
  const [clock, setClock] = useState(clockSec());
  useEffect(() => {
    const t = setInterval(() => setClock(clockSec()), 1000);
    return () => clearInterval(t);
  }, []);

  const monPx = d.state ? d.state.monUsd.toFixed(5) : '—';
  const block = d.state ? fmtInt(d.state.block) : '—';
  const liveColor = d.conn === 'live' ? C.green : d.conn === 'reconnecting' ? C.amber : C.faint;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, height: 42, padding: '0 16px',
      borderBottom: '1px solid rgba(255,255,255,.08)', position: 'sticky', top: 0, zIndex: 50, background: C.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10.5" stroke={C.purple} strokeWidth="1.3" />
          <polygon points="12,6 18,12 12,18 6,12" stroke={C.purple} strokeWidth="1.3" fill="none" />
          <circle cx="12" cy="12" r="1.7" fill={C.purple} />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.01em', fontFamily: SANS }}>propAMM</span>
        <span style={{ fontSize: 8.5, color: C.purpleL, border: '1px solid rgba(131,110,249,.4)', borderRadius: 3, padding: '2px 6px', letterSpacing: '.08em' }}>
          {d.state?.source === 'live' ? 'MONAD MAINNET' : 'MONAD · SIM'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 1, marginLeft: 8 }}>
        {TABS.map((t, i) => (
          <div key={t.id} onClick={() => d.set('tab', t.id)} style={{
            fontSize: 11, padding: '6px 12px', cursor: 'pointer',
            borderBottom: `2px solid ${d.tab === t.id ? C.purple : 'transparent'}`,
            color: d.tab === t.id ? '#fff' : C.faint,
          }}>[{i + 1}] {t.label}</div>
        ))}
        <div style={{ fontSize: 11, padding: '6px 12px', color: C.faint2, cursor: 'default' }}>[5] DOCS ↗</div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 15, fontSize: 10, color: C.faint }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: liveColor }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: liveColor, animation: 'blink 1.6s infinite' }} />
          {d.conn === 'live' ? 'live' : d.conn === 'reconnecting' ? 'reconnecting' : 'connecting'}
        </span>
        <span>MON <span style={{ color: C.text }}>${monPx}</span></span>
        <span>BLOCK <span style={{ color: C.text }}>{block}</span></span>
        <span>UTC <span style={{ color: C.text }}>{clock}</span></span>
      </div>
    </div>
  );
}
