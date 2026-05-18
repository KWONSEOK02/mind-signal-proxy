import { describe, it, expect } from 'vitest';
import { nowNs } from '../services/ingress-clock';

describe('nowNs()', () => {
  it('is in the epoch nanosecond domain (matches BigInt(Date.now())*1e6 within ±5s)', () => {
    const diff = BigInt(nowNs()) - BigInt(Date.now()) * 1_000_000n;
    expect(diff > -5_000_000_000n && diff < 5_000_000_000n).toBe(true);
  });

  it('is strictly monotonic increasing on two consecutive calls', () => {
    const prev = nowNs();
    expect(BigInt(nowNs()) > BigInt(prev)).toBe(true);
  });

  it('returns a decimal string of at most 21 digits (envelope.ts /^\\d{1,21}$/ bound)', () => {
    const s = nowNs();
    expect(/^\d{1,21}$/.test(s)).toBe(true);
    expect(s.length).toBeLessThanOrEqual(21);
  });
});
