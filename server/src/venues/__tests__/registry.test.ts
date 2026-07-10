import { describe, it, expect } from 'vitest';
import { validateRegistry, venueMeta } from '../registry.js';
import { percentile } from '@shared';

describe('venue registry', () => {
  it('validates: unique kebab-case ids, no adapter-side references, quote-only baselines', () => {
    expect(() => validateRegistry()).not.toThrow();
  });

  it('every venue has both theme colors and a role', () => {
    for (const v of venueMeta()) {
      expect(v.color.light).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(v.color.dark).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(['venue', 'reference', 'baseline']).toContain(v.role);
    }
  });

  it('display venues carry sinceUtc (per-day views + gas history anchor on it)', () => {
    for (const v of venueMeta().filter((x) => x.role === 'venue')) {
      expect(v.sinceUtc, `${v.id} is missing sinceUtc`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('shared percentile (leaderboard + client share one implementation)', () => {
  it('linear interpolation', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});
