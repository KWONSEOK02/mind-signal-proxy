import { describe, it, expect } from 'vitest';
import { PairBuffer, PushOutcome } from '../services/pair-buffer';
import type { SampleEnvelope } from '../types/envelope';

/** Build a minimal valid SampleEnvelope */
function makeEnvelope(
  subjectIdx: number,
  seq: number,
  proxyIngressTsNs: bigint,
  groupId = 'g1',
): SampleEnvelope {
  return {
    group_id: groupId,
    subject_idx: subjectIdx,
    de_ts_ns: '1000000000',
    proxy_ingress_ts_ns: proxyIngressTsNs.toString(),
    seq,
    payload: { delta: 0.1, theta: 0.2, alpha: 0.3, beta: 0.4, gamma: 0.5 },
    sync_meta: {},
  };
}

/** 100 ms in nanoseconds */
const WINDOW_NS = BigInt(100) * BigInt(1_000_000);

describe('PairBuffer', () => {
  describe("'matched' path", () => {
    it('returns matched when counterpart arrives within 100ms window', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');

      const outcome1 = buf.push(makeEnvelope(0, 1, t0));
      expect(outcome1).toBe(PushOutcome.Gap); // no counterpart yet

      // subject 1 arrives within window
      const outcome2 = buf.push(makeEnvelope(1, 1, t0 + BigInt(50_000_000))); // +50ms
      expect(outcome2).toBe(PushOutcome.Matched);
    });

    it('drained pair contains both subjects after matched push', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');

      buf.push(makeEnvelope(0, 1, t0));
      buf.push(makeEnvelope(1, 1, t0 + BigInt(30_000_000))); // +30ms

      const pairs = buf.drainMatched();
      expect(pairs.length).toBeGreaterThanOrEqual(1);
      const pair = pairs[0];
      const subjectIndices = pair.map((e) => e.subject_idx).sort();
      expect(subjectIndices).toEqual([0, 1]);
    });

    it('matched pair ns delta is within PAIRED_WINDOW_MS (100ms = 1e8 ns) — BigInt compare', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      const delta = BigInt(80_000_000); // 80ms, within window

      buf.push(makeEnvelope(0, 1, t0));
      buf.push(makeEnvelope(1, 1, t0 + delta));

      const pairs = buf.drainMatched();
      expect(pairs.length).toBe(1);
      const [e0, e1] = pairs[0].sort((a, b) => a.subject_idx - b.subject_idx);
      const ns0 = BigInt(e0.proxy_ingress_ts_ns);
      const ns1 = BigInt(e1.proxy_ingress_ts_ns);
      const diff = ns1 >= ns0 ? ns1 - ns0 : ns0 - ns1;
      expect(diff <= WINDOW_NS).toBe(true);
    });
  });

  describe("'gap' path", () => {
    it('returns gap when only one subject has been pushed', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      const outcome = buf.push(makeEnvelope(0, 1, t0));
      expect(outcome).toBe(PushOutcome.Gap);
    });

    it('drains nothing when only gap envelopes', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      buf.push(makeEnvelope(0, 1, t0));
      expect(buf.drainMatched()).toHaveLength(0);
    });

    it('returns gap when counterpart is outside 100ms window', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      buf.push(makeEnvelope(0, 1, t0));
      // subject 1 arrives 200ms later — outside window
      const outcome = buf.push(makeEnvelope(1, 1, t0 + BigInt(200_000_000)));
      expect(outcome).toBe(PushOutcome.Gap);
    });
  });

  describe("'dropped' path (CX-3)", () => {
    it('returns dropped when buffer exceeds PAIR_BUFFER_SIZE for a subject', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');

      // Fill to capacity (1024) for subject 0 without any counterpart from subject 1
      // Push 1024 envelopes with staggered timestamps so none expire in window
      let lastOutcome: PushOutcome = PushOutcome.Gap;
      for (let i = 1; i <= 1025; i++) {
        // Each envelope separated by 200ms so they don't match each other
        const ts = t0 + BigInt(i) * BigInt(200_000_000);
        lastOutcome = buf.push(makeEnvelope(0, i, ts));
      }
      expect(lastOutcome).toBe(PushOutcome.Dropped);
    });

    it('sync_meta contains CX-3 fields on dropped outcome', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');

      let dropMeta: Record<string, unknown> | undefined;
      for (let i = 1; i <= 1025; i++) {
        const ts = t0 + BigInt(i) * BigInt(200_000_000);
        const env = makeEnvelope(0, i, ts);
        const outcome = buf.push(env);
        if (outcome === PushOutcome.Dropped) {
          dropMeta = buf.getLastDropMeta();
          break;
        }
      }

      expect(dropMeta).toBeDefined();
      expect(dropMeta!['drop_reason']).toBe('buffer_overflow');
      expect(typeof dropMeta!['queue_depth']).toBe('number');
      const ranges = dropMeta!['dropped_seq_ranges'] as Array<{ from: number; to: number }>;
      expect(Array.isArray(ranges)).toBe(true);
      expect(ranges.length).toBeGreaterThan(0);
      expect(typeof ranges[0].from).toBe('number');
      expect(typeof ranges[0].to).toBe('number');
    });
  });

  describe('S5 metric — monotonic proxy_ingress_ts_ns per subject', () => {
    it('forwarded proxy_ingress_ts_ns is monotonically non-decreasing per subject after push sequence', () => {
      const buf = new PairBuffer();
      const base = BigInt('1700000000000000000');

      // Push 5 pairs, each 10ms apart, paired within window (subject 1 = +5ms)
      for (let i = 0; i < 5; i++) {
        const t = base + BigInt(i) * BigInt(10_000_000);
        buf.push(makeEnvelope(0, i + 1, t));
        buf.push(makeEnvelope(1, i + 1, t + BigInt(5_000_000)));
      }

      const pairs = buf.drainMatched();
      // Extract subject 0 timestamps in push order — assert monotonic non-decreasing.
      const sub0Ts = pairs
        .map((pair) => pair.find((e) => e.subject_idx === 0))
        .filter(Boolean)
        .map((e) => BigInt(e!.proxy_ingress_ts_ns));

      for (let i = 1; i < sub0Ts.length; i++) {
        expect(sub0Ts[i]).toBeGreaterThanOrEqual(sub0Ts[i - 1]);
      }

      // Assert each matched pair's intra-pair |ns delta| <= PAIRED_WINDOW_MS * 1_000_000 ns.
      const windowNs = BigInt(100) * 1_000_000n;
      for (const [a, b] of pairs) {
        const nsA = BigInt(a.proxy_ingress_ts_ns);
        const nsB = BigInt(b.proxy_ingress_ts_ns);
        const d = nsA >= nsB ? nsA - nsB : nsB - nsA;
        expect(d <= windowNs).toBe(true);
      }
    });
  });
});
