import { describe, it, expect } from 'vitest';
import { StimulusFanout } from '../services/stimulus-fanout';
import type { StimulusEvent, FanoutTarget } from '../services/stimulus-fanout';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeEvent(groupId = 'g1', timestamp_ms = 1000): StimulusEvent {
  return { groupId, timestamp_ms };
}

// ──────────────────────────────────────────────────────────────────────────────

describe('StimulusFanout', () => {
  // ────────────────────────────────────────────────────────────────────────────
  // (a) Parallel dispatch / ≤5 ms start-time spread
  //
  // WHY this is non-tautological: a naive `for…await` implementation would await
  // target A's deliver() before calling target B's deliver(). Since target A
  // sleeps 50 ms, target B's start time would be ≈ startA + 50 ms, making the
  // difference ~50 000 000 ns — far above the 5 000 000 ns limit. Only a
  // concurrent dispatch (collect promises first, then allSettled) passes.
  // ────────────────────────────────────────────────────────────────────────────
  it('(a) dispatches both targets concurrently — start-time spread ≤ 5 ms', async () => {
    const fanout = new StimulusFanout();
    let startA = 0n;
    let startB = 0n;

    const targetA: FanoutTarget = {
      id: 'DE_A',
      kind: 'loopback',
      deliver: async (_event: StimulusEvent) => {
        startA = process.hrtime.bigint();
        await delay(50); // long sleep to expose sequential ordering
      },
    };

    const targetB: FanoutTarget = {
      id: 'DE_B',
      kind: 'http',
      deliver: async (_event: StimulusEvent) => {
        startB = process.hrtime.bigint(); // captured immediately
      },
    };

    fanout.addTarget(targetA);
    fanout.addTarget(targetB);

    await fanout.broadcast(makeEvent());

    const diffNs = startA >= startB ? startA - startB : startB - startA;
    // 5 ms = 5_000_000 ns
    expect(diffNs).toBeLessThanOrEqual(5_000_000n);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // (b) Verbatim forwarding — ADR §C no-mutation invariant
  // ────────────────────────────────────────────────────────────────────────────
  it('(b) forwards the event verbatim to every target (ADR §C no-mutation)', async () => {
    const fanout = new StimulusFanout();
    const received: StimulusEvent[] = [];

    const makeCapture = (id: string): FanoutTarget => ({
      id,
      kind: 'http',
      deliver: async (event: StimulusEvent) => {
        received.push(event);
      },
    });

    fanout.addTarget(makeCapture('DE_A'));
    fanout.addTarget(makeCapture('DE_B'));

    const original = makeEvent('session-42', 9999);
    await fanout.broadcast(original);

    expect(received).toHaveLength(2);
    for (const evt of received) {
      // Deep-equal check on all fields — proxy must NOT mutate anything.
      expect(evt).toEqual(original);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // (c) R1 isolation — one target failure must not block the other
  // ────────────────────────────────────────────────────────────────────────────
  it('(c) a failing target does not block the other; result reflects both outcomes', async () => {
    const fanout = new StimulusFanout();
    const receivedB: StimulusEvent[] = [];

    const targetA: FanoutTarget = {
      id: 'DE_A',
      kind: 'loopback',
      deliver: async (_event: StimulusEvent) => {
        throw new Error('DE_A timeout');
      },
    };

    const targetB: FanoutTarget = {
      id: 'DE_B',
      kind: 'http',
      deliver: async (event: StimulusEvent) => {
        receivedB.push(event);
      },
    };

    fanout.addTarget(targetA);
    fanout.addTarget(targetB);

    // broadcast must NOT throw even though target A fails
    const results = await fanout.broadcast(makeEvent());

    expect(results).toHaveLength(2);

    const resultA = results.find((r) => r.id === 'DE_A');
    const resultB = results.find((r) => r.id === 'DE_B');

    expect(resultA).toEqual({ id: 'DE_A', ok: false, error: 'DE_A timeout' });
    expect(resultB).toEqual({ id: 'DE_B', ok: true });

    // target B still received the event exactly once
    expect(receivedB).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // (c2) R1 isolation — synchronous throw from deliver() must not escape broadcast
  //
  // WHY this is non-tautological: the pre-fix code uses snapshot.map(target =>
  // target.deliver(event)). If deliver() throws synchronously, the exception
  // escapes Array.prototype.map, Promise.allSettled is never reached, and
  // broadcast() rejects entirely — skipping all later targets. The fix wraps
  // each call in try/catch so a synchronous throw becomes a rejected promise,
  // which Promise.allSettled handles correctly. This test fails against the
  // pre-fix code (broadcast rejects instead of resolving) and passes after.
  // ────────────────────────────────────────────────────────────────────────────
  it('(c2) synchronous throw from deliver() is isolated — broadcast resolves and other target still receives', async () => {
    const fanout = new StimulusFanout();
    const receivedB: StimulusEvent[] = [];

    const targetA: FanoutTarget = {
      id: 'DE_A',
      kind: 'loopback',
      deliver(_e: StimulusEvent): Promise<void> {
        throw new Error('DE_A sync boom');
      },
    };

    const targetB: FanoutTarget = {
      id: 'DE_B',
      kind: 'http',
      deliver: async (event: StimulusEvent) => {
        receivedB.push(event);
      },
    };

    fanout.addTarget(targetA);
    fanout.addTarget(targetB);

    // broadcast must NOT throw even though targetA throws synchronously
    const results = await fanout.broadcast(makeEvent());

    expect(results).toHaveLength(2);

    const resultA = results.find((r) => r.id === 'DE_A');
    const resultB = results.find((r) => r.id === 'DE_B');

    expect(resultA).toEqual({ id: 'DE_A', ok: false, error: 'DE_A sync boom' });
    expect(resultB).toEqual({ id: 'DE_B', ok: true });

    // targetB must have received the event exactly once despite targetA's sync throw
    expect(receivedB).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // (d) Target management
  // ────────────────────────────────────────────────────────────────────────────
  describe('(d) target management', () => {
    it('addTarget — same id overwrites; only the latest instance delivers', async () => {
      const fanout = new StimulusFanout();
      const deliveredBy: string[] = [];

      const v1: FanoutTarget = {
        id: 'DE_A',
        kind: 'loopback',
        deliver: async (_e) => {
          deliveredBy.push('v1');
        },
      };
      const v2: FanoutTarget = {
        id: 'DE_A',
        kind: 'loopback',
        deliver: async (_e) => {
          deliveredBy.push('v2');
        },
      };

      fanout.addTarget(v1);
      fanout.addTarget(v2); // overwrite

      expect(fanout.targetCount()).toBe(1);
      await fanout.broadcast(makeEvent());

      expect(deliveredBy).toEqual(['v2']);
    });

    it('removeTarget — removed id no longer receives events', async () => {
      const fanout = new StimulusFanout();
      const received: string[] = [];

      fanout.addTarget({
        id: 'DE_A',
        kind: 'loopback',
        deliver: async (_e) => {
          received.push('DE_A');
        },
      });
      fanout.addTarget({
        id: 'DE_B',
        kind: 'http',
        deliver: async (_e) => {
          received.push('DE_B');
        },
      });

      fanout.removeTarget('DE_A');
      expect(fanout.targetCount()).toBe(1);

      await fanout.broadcast(makeEvent());

      expect(received).toEqual(['DE_B']);
    });

    it('removeTarget on absent id is a no-op (no throw)', () => {
      const fanout = new StimulusFanout();
      expect(() => fanout.removeTarget('nonexistent')).not.toThrow();
    });

    it('broadcast with zero targets resolves to [] without throwing', async () => {
      const fanout = new StimulusFanout();
      const results = await fanout.broadcast(makeEvent());
      expect(results).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // (e) Snapshot determinism — targets added during an in-flight broadcast
  //     must NOT receive that broadcast's event
  // ────────────────────────────────────────────────────────────────────────────
  it('(e) target added after broadcast is called does not receive that broadcast', async () => {
    const fanout = new StimulusFanout();
    const receivedLate: StimulusEvent[] = [];

    // Slow target so broadcast is still "in-flight" when we add the late target.
    fanout.addTarget({
      id: 'DE_A',
      kind: 'loopback',
      deliver: async (_e) => {
        await delay(30);
      },
    });

    // Start broadcast but do NOT await yet.
    const broadcastPromise = fanout.broadcast(makeEvent());

    // Add a new target while the broadcast is in flight.
    fanout.addTarget({
      id: 'DE_LATE',
      kind: 'http',
      deliver: async (event: StimulusEvent) => {
        receivedLate.push(event);
      },
    });

    await broadcastPromise;

    // The late-added target must NOT have received the in-flight broadcast.
    expect(receivedLate).toHaveLength(0);
  }, 10_000);

  // ────────────────────────────────────────────────────────────────────────────
  // getTargetIds inspection helper
  // ────────────────────────────────────────────────────────────────────────────
  it('getTargetIds returns the ids of all registered targets', () => {
    const fanout = new StimulusFanout();
    fanout.addTarget({ id: 'DE_A', kind: 'loopback', deliver: async () => {} });
    fanout.addTarget({ id: 'DE_B', kind: 'http', deliver: async () => {} });
    expect(fanout.getTargetIds().sort()).toEqual(['DE_A', 'DE_B']);
  });
});
