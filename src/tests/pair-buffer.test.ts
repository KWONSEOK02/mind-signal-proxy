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

    it('cross-subject push within window returns Matched (both subjects paired)', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');

      buf.push(makeEnvelope(0, 1, t0));
      // 다른 subject가 window 내 도착 → Matched (cross-subject 짝 성립 의미)
      const outcome = buf.push(makeEnvelope(1, 1, t0 + BigInt(30_000_000))); // +30ms
      expect(outcome).toBe(PushOutcome.Matched);
    });

    it('returns Matched only when intra-pair ns delta <= PAIRED_WINDOW_MS (BigInt)', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      const delta = BigInt(80_000_000); // 80ms, within 100ms window

      buf.push(makeEnvelope(0, 1, t0));
      expect(buf.push(makeEnvelope(1, 1, t0 + delta))).toBe(PushOutcome.Matched);
    });
  });

  describe("'gap' path", () => {
    it('returns gap when only one subject has been pushed', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      const outcome = buf.push(makeEnvelope(0, 1, t0));
      expect(outcome).toBe(PushOutcome.Gap);
    });

    it('returns gap for repeated same-subject pushes (no counterpart)', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      expect(buf.push(makeEnvelope(0, 1, t0))).toBe(PushOutcome.Gap);
      // 같은 subject 재push — 짝 없음 → Gap 유지
      expect(buf.push(makeEnvelope(0, 2, t0 + BigInt(10_000_000)))).toBe(PushOutcome.Gap);
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

    it('overflow evicts oldest envelope and annotates its sync_meta.drop_reason as buffer_overflow', () => {
      // Use a small buffer (3) to avoid 1024 iterations
      const buf = new PairBuffer(3, 100);
      const t0 = BigInt('1700000000000000000');

      // Keep a ref to the first (oldest) envelope — this is the one that will be evicted
      const firstEnvelope = makeEnvelope(0, 1, t0);
      buf.push(firstEnvelope);

      // Push 2 more to fill to capacity (queue now has 3 items, each 200ms apart so no window match)
      buf.push(makeEnvelope(0, 2, t0 + BigInt(200_000_000)));
      buf.push(makeEnvelope(0, 3, t0 + BigInt(400_000_000)));

      // Push a 4th envelope: triggers overflow, firstEnvelope is evicted and annotated
      const outcome = buf.push(makeEnvelope(0, 4, t0 + BigInt(600_000_000)));

      expect(outcome).toBe(PushOutcome.Dropped);
      expect(firstEnvelope.sync_meta['drop_reason']).toBe('buffer_overflow');
    });
  });

  describe('S5 — 연속 in-window 짝 형성', () => {
    it('각 in-window subject 쌍마다 Matched 반환함 (5쌍)', () => {
      const buf = new PairBuffer();
      const base = BigInt('1700000000000000000');

      // 5쌍, 각 10ms 간격, window 내 짝(subject 1 = +5ms)
      for (let i = 0; i < 5; i++) {
        const t = base + BigInt(i) * BigInt(10_000_000);
        buf.push(makeEnvelope(0, i + 1, t));
        expect(buf.push(makeEnvelope(1, i + 1, t + BigInt(5_000_000)))).toBe(PushOutcome.Matched);
      }
    });
  });

  describe('memory leak regression — matched pairs 미누적', () => {
    // 누수: matchedPairs 배열이 push마다 누적되나 production(ingest.ts:52)은
    // 반환값을 무시하고 drain하지 않아 128Hz x 2 subject x 600s = 최대 76,800개
    // 무한 누적함. dead 저장소(matchedPairs/drainMatched) 제거로 차단함.
    // fix 전 RED(필드/메서드 존재) → fix 후 GREEN.
    it('matched 누적 저장소를 보유하지 않음', () => {
      const buf = new PairBuffer();
      const t0 = BigInt('1700000000000000000');
      for (let i = 0; i < 200; i++) {
        const t = t0 + BigInt(i) * BigInt(10_000_000);
        buf.push(makeEnvelope(0, i + 1, t));
        buf.push(makeEnvelope(1, i + 1, t + BigInt(5_000_000)));
      }
      expect(Reflect.get(buf, 'matchedPairs')).toBeUndefined();
      expect(Reflect.get(buf, 'drainMatched')).toBeUndefined();
    });
  });
});
