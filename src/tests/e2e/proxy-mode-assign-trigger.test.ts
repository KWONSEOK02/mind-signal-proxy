/**
 * E2E: proxy-mode-assign-trigger
 *
 * Node ephemeral mock-BE integration test (NOT Playwright).
 * Mirrors proxy-fan-in.test.ts conventions: node:http createServer, supertest, vi.waitFor,
 * dynamic import with process.env set before import.
 *
 * Three scenarios covering the R-C3 closure (BE pending mirror on /register + TTL evict DELETE).
 *
 * Common injection block used by all scenarios (PLAN §8-2 CX2-3):
 *   - BeNotifier with explicit backendUrl so BACKEND_URL='' guard does not trip.
 *   - PendingRegistry with onEvict wired to beNotifier.notifyUnregister.
 *   - createApp receives both registry and beNotifier as 2nd/4th arg.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'net';

const TEST_SECRET = 'test-engine-secret-xyz';

// Must be set BEFORE dynamic import of config/index so ENGINE_SECRET_KEY is loaded correctly.
process.env['ENGINE_SECRET_KEY'] = TEST_SECRET;

// Dynamically-loaded modules (same pattern as proxy-fan-in.test.ts).
let createApp: (typeof import('../../index'))['createApp'];
let BeNotifier: (typeof import('../../services/be-notifier'))['BeNotifier'];
let PendingRegistry: (typeof import('../../services/pending-registry'))['PendingRegistry'];

beforeAll(async () => {
  ({ createApp } = await import('../../index'));
  ({ BeNotifier } = await import('../../services/be-notifier'));
  ({ PendingRegistry } = await import('../../services/pending-registry'));
}, 30_000);

// TTL used for Scenario 2: short enough that fakeScheduler can fire it deterministically.
const TTL_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Fake scheduler for PendingRegistry TTL (deterministic, no real setTimeout)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeTimerEntry {
  id: number;
  delayMs: number;
  fn: () => void;
  fired: boolean;
}

function makeFakeScheduler(): {
  scheduler: {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };
  fireAllBefore: (ms: number) => void;
} {
  const timers: Map<number, FakeTimerEntry> = new Map();
  let nextId = 1;

  const scheduler = {
    setTimeout(fn: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout> {
      const id = nextId++;
      timers.set(id, { id, delayMs, fn, fired: false });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void {
      const id = handle as unknown as number;
      timers.delete(id);
    },
  };

  return {
    scheduler: scheduler as unknown as {
      setTimeout: typeof globalThis.setTimeout;
      clearTimeout: typeof globalThis.clearTimeout;
    },
    fireAllBefore(ms: number): void {
      for (const t of [...timers.values()]) {
        if (!t.fired && t.delayMs <= ms) {
          t.fired = true;
          timers.delete(t.id);
          t.fn();
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake setTimer for BeNotifier (returns numeric handle — clearTimeout no-op safe)
// Used in Scenarios 1 and 3 where timer firing is not needed.
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeSetTimer(): (cb: () => void, ms: number) => ReturnType<typeof setTimeout> {
  let nextId = 200;
  return (_cb: () => void, _ms: number): ReturnType<typeof setTimeout> => {
    return nextId++ as unknown as ReturnType<typeof setTimeout>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock BE HTTP server helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BeCapture {
  method: string;
  body: unknown;
}

/**
 * Start a mock BE server handling both POST and DELETE on /api/engine/register-pending.
 * statusByMethod allows per-method status codes (default 200).
 */
function startMockBeServer(
  statusByMethod: { POST?: number; DELETE?: number } = {},
): Promise<{ url: string; captures: BeCapture[]; close: () => Promise<void> }> {
  const captures: BeCapture[] = [];

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
        const method = req.method ?? 'GET';
        captures.push({ method, body: parsedBody });

        const status =
          method === 'POST'
            ? (statusByMethod.POST ?? 200)
            : method === 'DELETE'
              ? (statusByMethod.DELETE ?? 200)
              : 200;

        const responseBody =
          method === 'POST'
            ? JSON.stringify({ status: 'registered' })
            : JSON.stringify({ deleted: true });

        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        captures,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: R-C3 폐쇄 풀체인 Happy Path
// ─────────────────────────────────────────────────────────────────────────────

describe('proxy-mode-assign-trigger e2e: R-C3 폐쇄 풀체인 Happy Path (Scenario 1)', () => {
  let beNotifier: InstanceType<typeof BeNotifier>;
  let registry: InstanceType<typeof PendingRegistry>;

  afterEach(async () => {
    beNotifier?.abortAll();
    registry?.clearAll();
  });

  it('POST /register x2 → mock BE receives 2 register-pending POSTs; assign-group forwards to 2 DEs', async () => {
    const mockBe = await startMockBeServer({ POST: 200 });

    const fakeSetTimer = makeFakeSetTimer();
    beNotifier = new BeNotifier({
      backendUrl: mockBe.url,
      engineSecret: TEST_SECRET,
      setTimer: fakeSetTimer,
      timeoutMs: 999_999_999,
    });

    registry = new PendingRegistry(999_999_999, globalThis, (i: number, u: string) => {
      if (i !== 1 && i !== 2) return;
      beNotifier.notifyUnregister({ subjectIndex: i as 1 | 2, engineUrl: u });
    });

    const app = createApp(undefined, registry, undefined, beNotifier);

    // Register DE subject 1
    const res1 = await request(app)
      .post('/register')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1, de_url: 'http://127.0.0.1:5901' });
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ ok: true });

    // Register DE subject 2
    const res2 = await request(app)
      .post('/register')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 2, de_url: 'http://127.0.0.1:5902' });
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ ok: true });

    // Notify is async fire-and-forget: wait until mock BE received both POSTs.
    // Conceptual: captured POST count (2) is the pre-fix=0 R-C3 closure proof
    // (mock capture count, not real BE registryService).
    await vi.waitFor(() => expect(mockBe.captures.length).toBe(2), { timeout: 5000 });

    // Assert both captured bodies match expected shape (order-insensitive)
    const bodies = mockBe.captures.map((c) => c.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { subjectIndex: 1, engineUrl: 'http://127.0.0.1:5901', secretKey: TEST_SECRET },
        { subjectIndex: 2, engineUrl: 'http://127.0.0.1:5902', secretKey: TEST_SECRET },
      ]),
    );

    // POST assign-group: registry has 2 entries, forwarded array length = 2.
    // Forward targets are DE URLs that refuse connection; route still returns 200.
    // ok flags may be false (connection refused) but forwarded array must have length 2.
    const assignRes = await request(app)
      .post('/control/assign-group')
      .set('x-engine-secret', TEST_SECRET)
      .send({ group_id: 'g1' });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.forwarded).toHaveLength(2);

    // Registry remains source of truth for proxy
    expect(registry.resolve(1)).toBe('http://127.0.0.1:5901');
    expect(registry.resolve(2)).toBe('http://127.0.0.1:5902');

    await mockBe.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: TTL-evict deregister 동기화 Contract Path
// ─────────────────────────────────────────────────────────────────────────────

describe('proxy-mode-assign-trigger e2e: TTL-evict deregister 동기화 Contract Path (Scenario 2)', () => {
  let beNotifier: InstanceType<typeof BeNotifier>;
  let registry: InstanceType<typeof PendingRegistry>;

  afterEach(async () => {
    beNotifier?.abortAll();
    registry?.clearAll();
  });

  it('TTL fire → onEvict → beNotifier.notifyUnregister → mock BE receives DELETE with original de_url', async () => {
    const mockBe = await startMockBeServer({ POST: 200, DELETE: 200 });

    const fakeScheduler = makeFakeScheduler();

    // BeNotifier uses real fetch (no fake setTimer needed — notify succeeds on first try).
    beNotifier = new BeNotifier({
      backendUrl: mockBe.url,
      engineSecret: TEST_SECRET,
      timeoutMs: 999_999_999,
    });

    registry = new PendingRegistry(TTL_MS, fakeScheduler.scheduler, (i: number, u: string) => {
      if (i !== 1 && i !== 2) return;
      beNotifier.notifyUnregister({ subjectIndex: i as 1 | 2, engineUrl: u });
    });

    const app = createApp(undefined, registry, undefined, beNotifier);

    // Register DE subject 1
    const res1 = await request(app)
      .post('/register')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1, de_url: 'http://127.0.0.1:5901' });
    expect(res1.status).toBe(200);

    // Wait until BE received the POST register-pending
    await vi.waitFor(() => expect(mockBe.captures.some((c) => c.method === 'POST')).toBe(true), {
      timeout: 5000,
    });

    // Registry should have 1 entry
    expect(registry.size()).toBe(1);

    // Fire the TTL timer for subject 1 (delayMs = TTL_MS = 500)
    fakeScheduler.fireAllBefore(TTL_MS);

    // After TTL fire → onEvict → notifyUnregister → mock BE should receive DELETE
    await vi.waitFor(() => expect(mockBe.captures.some((c) => c.method === 'DELETE')).toBe(true), {
      timeout: 5000,
    });

    // Find the DELETE capture and verify its body matches original de_url
    const deleteCapture = mockBe.captures.find((c) => c.method === 'DELETE');
    expect(deleteCapture).toBeDefined();
    expect(deleteCapture!.body).toEqual({
      subjectIndex: 1,
      engineUrl: 'http://127.0.0.1:5901',
      secretKey: TEST_SECRET,
    });

    await mockBe.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: 403 notify-failure Error Path
// ─────────────────────────────────────────────────────────────────────────────

describe('proxy-mode-assign-trigger e2e: 403 notify-failure Error Path (Scenario 3)', () => {
  let beNotifier: InstanceType<typeof BeNotifier>;
  let registry: InstanceType<typeof PendingRegistry>;

  afterEach(async () => {
    beNotifier?.abortAll();
    registry?.clearAll();
  });

  it('BE returns 403 → notify state=failed; /register still returns 200 (DE register not blocked)', async () => {
    const mockBe = await startMockBeServer({ POST: 403 });

    const fakeSetTimer = makeFakeSetTimer();
    beNotifier = new BeNotifier({
      backendUrl: mockBe.url,
      engineSecret: TEST_SECRET,
      setTimer: fakeSetTimer,
      timeoutMs: 999_999_999,
    });

    registry = new PendingRegistry(999_999_999, globalThis, (i: number, u: string) => {
      if (i !== 1 && i !== 2) return;
      beNotifier.notifyUnregister({ subjectIndex: i as 1 | 2, engineUrl: u });
    });

    const app = createApp(undefined, registry, undefined, beNotifier);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // POST /register subject 1 — must return 200 even though BE will reject notify with 403
      // DISCUSS Q2: DE register must NOT be blocked by notify failure
      const res1 = await request(app)
        .post('/register')
        .set('x-engine-secret', TEST_SECRET)
        .send({ subject_idx: 1, de_url: 'http://127.0.0.1:5901' });

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ ok: true });

      // Wait for BeNotifier to process the 403 response and reach failed state
      await vi.waitFor(() => expect(beNotifier.getState(1)).toBe('failed'), { timeout: 5000 });

      // Assert console.error was called with reason=http_403
      const hasHttp403Error = errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('reason=http_403'),
      );
      expect(hasHttp403Error).toBe(true);

      // Assert no retry: 403 is non-retryable, mock BE received exactly 1 POST
      expect(mockBe.captures.filter((c) => c.method === 'POST').length).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }

    await mockBe.close();
  });
});
