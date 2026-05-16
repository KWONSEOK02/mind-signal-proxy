import { describe, it, expect } from 'vitest';
import { nowNs } from '../services/ingress-clock';

describe('nowNs()', () => {
  it('returns a string matching /^\\d+$/', () => {
    const result = nowNs();
    expect(result).toMatch(/^\d+$/);
  });

  it('is monotonic non-decreasing on two consecutive calls', () => {
    const first = BigInt(nowNs());
    const second = BigInt(nowNs());
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
