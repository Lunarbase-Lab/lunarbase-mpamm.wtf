/** Design tokens lifted verbatim from propAMM.dc.html so the React port is
 *  pixel-faithful. */

export const C = {
  bg: '#08090B',
  panel: '#0A0C10',
  text: '#E6E7EA',
  text2: '#cdcfd6',
  text3: '#b9bac2',
  dim: '#9a9ba3',
  dim2: '#8b8c95',
  dim3: '#7a7c84',
  faint: '#6b6d76',
  faint2: '#5e6068',
  faint3: '#4a4c54',
  ghost: '#3a3c44',
  line: 'rgba(255,255,255,.07)',
  line2: 'rgba(255,255,255,.06)',
  line3: 'rgba(255,255,255,.04)',
  hair: 'rgba(255,255,255,.035)',

  purple: '#836EF9',
  purpleL: '#9A88FF',
  lilac: '#c4b6ff',
  lilac2: '#cdd3ff',
  green: '#35D0A0',
  red: '#F2566A',
  blue: '#6E8BFF',
  cyan: '#45C8E8',
  amber: '#E0A33E',
  bybit: '#B9BCC6',
} as const;

export const MONO = "'JetBrains Mono','SF Mono',monospace";
export const SANS = "'Space Grotesk',sans-serif";

/** rgba() from a #rrggbb hex + alpha (DCLogic.hex). */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Decorative corner brackets used on every panel in the design. */
export const cornerTL: React.CSSProperties = {
  position: 'absolute', top: -1, left: -1, width: 8, height: 8,
  borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}`,
};
export const cornerBR: React.CSSProperties = {
  position: 'absolute', bottom: -1, right: -1, width: 8, height: 8,
  borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}`,
};

/** Selected/unselected pill (DCLogic pillOn/pillOff). `sm` matches the smaller
 *  10px pills used in the volume/markout/leaderboard controls. */
export function pill(active: boolean, sm = false): React.CSSProperties {
  return {
    background: active ? C.purple : 'transparent',
    color: active ? '#fff' : C.dim2,
    border: `1px solid ${active ? C.purple : 'rgba(255,255,255,.13)'}`,
    padding: sm ? '3px 8px' : '4px 9px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: sm ? 10 : 11,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };
}
