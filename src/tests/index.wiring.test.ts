import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, connectBeForwarderWithRetry } from '../index';
import type { PairBufferPort, BeForwarderPort } from '../routes/ingest';
import { PushOutcome } from '../services/pair-buffer';
import { HealthMonitor } from '../services/health-monitor';

// ── Group A: createApp wiring via supertest ─────────────────────────────────

describe('Group A — createApp wiring (supertest)', () => {
  let pairBuffer: PairBufferPort;
  let beForwarder: BeForwarderPort;

  beforeEach(() => {
    pairBuffer = { push: vi.fn(() => PushOutcome.Gap) };
    beForwarder = { forward: vi.fn() };
  });

  it('A-1: POST /ingest/sample → NOT 501 (real ingest router wired, returns 401 fail-closed)', async () => {
    const app = createApp(undefined, undefined, { pairBuffer, beForwarder });
    const res = await request(app)
      .post('/ingest/sample')
      .set('Content-Type', 'application/json')
      .send({ dummy: true });

    // Real router is wired: fail-closed 401 on missing/empty engine secret
    expect(res.status).not.toBe(501);
    expect(res.status).toBe(401);
  });

  it('A-2: POST /heartbeat with monitor → 200 { status:"ok", healthy:true }', async () => {
    const monitor = new HealthMonitor(1000, 3000);
    const app = createApp(monitor, undefined, { pairBuffer, beForwarder });
    const res = await request(app)
      .post('/heartbeat')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).not.toBe(501);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.healthy).toBe(true);
  });

  it('A-3: createApp() no-arg backward-compat → GET /health → 200 { status:"ok" }', async () => {
    // Must not throw, must not open a socket
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── Group B: connectBeForwarderWithRetry pass-only guard (R2-2) ─────────────

describe('Group B — connectBeForwarderWithRetry retry behaviour', () => {
  it('B-1: schedules retry on failure with 1000ms backoff, and re-invokes connect on tick', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(undefined);

    const bf = { connect };

    const timers: Array<{ cb: () => void; ms: number }> = [];
    const setTimer = (cb: () => void, ms: number): void => {
      timers.push({ cb, ms });
    };

    // Call — connect() is called immediately (attempt=0)
    connectBeForwarderWithRetry(bf, { setTimer });

    // Flush the rejection microtask
    await vi.waitFor(() => expect(timers).toHaveLength(1));

    // 1 timer scheduled with backoff = 1000 * 2**0 = 1000
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);
    // connect called exactly once so far
    expect(connect).toHaveBeenCalledTimes(1);

    // Invoke the scheduled retry callback
    timers[0].cb();

    // Flush the resolving microtask
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    // connect called exactly 2 times total (proves real retry recursion, not no-op)
    expect(connect).toHaveBeenCalledTimes(2);

    // No new timer after the resolving attempt
    expect(timers).toHaveLength(1);
  });
});
