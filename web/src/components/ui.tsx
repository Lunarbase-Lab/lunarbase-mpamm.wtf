import type { CSSProperties, ReactNode } from 'react';
import { C, cornerTL, cornerBR, pill } from '../theme';

/** Bordered panel with the design's purple corner brackets. */
export function Panel({ children, style, both = true }: { children: ReactNode; style?: CSSProperties; both?: boolean }) {
  return (
    <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, ...style }}>
      <i style={cornerTL} />
      {both && <i style={cornerBR} />}
      {children}
    </div>
  );
}

/** Standard panel header: "<icon> TITLE  subtitle" + optional right slot. */
export function PanelHead({ icon, iconColor = C.purple, title, sub, right }: {
  icon: string; iconColor?: string; title: string; sub?: ReactNode; right?: ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
      padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em',
    }}>
      <div>
        <span style={{ color: iconColor }}>{icon}</span>{' '}
        <span style={{ color: C.text, fontWeight: 600 }}>{title}</span>
        {sub != null && <span style={{ color: C.faint }}> {sub}</span>}
      </div>
      {right}
    </div>
  );
}

export interface PillOpt { label: string; value: string | number; }

/** Row of selectable pills (DCLogic pillOn/pillOff). */
export function Pills({ options, value, onChange, sm = false }: {
  options: (PillOpt | string)[]; value: string | number; onChange: (v: any) => void; sm?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: sm ? 3 : 4 }}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { label: o, value: o } : o;
        return (
          <button key={String(opt.value)} type="button" aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)} style={pill(value === opt.value, sm)}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** A tiny labelled control group (LABEL  <pills>). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 9, color: C.faint2, letterSpacing: '.08em' }}>{label}</span>
      {children}
    </div>
  );
}

/** Coloured BUY/SELL chip. */
export function SideTag({ side }: { side: string }) {
  const buy = side.toLowerCase() === 'buy';
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
      border: `1px solid ${buy ? 'var(--green-border)' : 'var(--red-border)'}`,
      color: buy ? C.green : C.red,
    }}>{side.toUpperCase()}</span>
  );
}

export const PAGE_PAD = 18;
