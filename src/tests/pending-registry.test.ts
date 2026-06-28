import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { PendingRegistry } from '../services/pending-registry';
import { createRegisterRouter } from '../routes/register';
import { createControlAssignGroupRouter } from '../routes/control-assign-group';
import { createApp } from '../index';
import express from 'express';

const TEST_SECRET = 'test-engine-secret-xyz';

// ─────────────────────────────────────────────────────────────────────────────
// Fake scheduler — injectable so timers are deterministic (no real setTimeout)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeTimer {
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
  fire: (timerId: number) => void;
  fireAllBefore: (ms: number) => void;
  pendingCount: () => number;
} {
  const timers: Map<number, FakeTimer> = new Map();
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
    fire(timerId: number): void {
      const t = timers.get(timerId);
      if (t && !t.fired) {
        t.fired = true;
        timers.delete(timerId);
        t.fn();
      }
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
    pendingCount(): number {
      return timers.size;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — mock DE HTTP server
// ─────────────────────────────────────────────────────────────────────────────

interface MockDeCapture {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function startMockDeServer(
  statusCode = 200,
): Promise<{ url: string; captures: MockDeCapture[]; close: () => Promise<void> }> {
  const captures: MockDeCapture[] = [];

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
        captures.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: parsedBody,
        });
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.on('error', reject);

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      const url = `http://localhost:${addr.port}`;
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
// Unit — PendingRegistry core
// ─────────────────────────────────────────────────────────────────────────────

describe('PendingRegistry — unit: register / resolve / unregister', () => {
  let registry: PendingRegistry;
  let fakeSchedulerSetup: ReturnType<typeof makeFakeScheduler>;

  beforeEach(() => {
    // Fresh fake scheduler per test so nextId never accumulates across tests.
    fakeSchedulerSetup = makeFakeScheduler();
    // Use a very large TTL so TTL never fires during basic unit tests
    registry = new PendingRegistry(999_999_999, fakeSchedulerSetup.scheduler);
  });

  afterEach(() => {
    registry.clearAll();
  });

  it('resolve returns undefined for an unknown subjectIdx', () => {
    expect(registry.resolve(99)).toBeUndefined();
  });

  it('register then resolve returns the registered URL', () => {
    registry.register(0, 'http://de-a:8000');
    expect(registry.resolve(0)).toBe('http://de-a:8000');
  });

  it('size() returns 0 initially', () => {
    expect(registry.entries().length).toBe(0);
  });

  it('size() increments after register', () => {
    registry.register(0, 'http://de-a:8000');
    registry.register(1, 'http://de-b:8001');
    expect(registry.entries().length).toBe(2);
  });

  it('unregister removes the entry', () => {
    registry.register(0, 'http://de-a:8000');
    registry.unregister(0);
    expect(registry.resolve(0)).toBeUndefined();
    expect(registry.entries().length).toBe(0);
  });

  it('unregister on non-existent key is a no-op', () => {
    expect(() => registry.unregister(999)).not.toThrow();
  });

  it('entries() returns a snapshot of all registered entries', () => {
    registry.register(0, 'http://de-a:8000');
    registry.register(1, 'http://de-b:8001');
    const snap = registry.entries();
    expect(snap).toHaveLength(2);
    expect(snap.find((e) => e.subjectIdx === 0)?.deUrl).toBe('http://de-a:8000');
    expect(snap.find((e) => e.subjectIdx === 1)?.deUrl).toBe('http://de-b:8001');
  });

  it('entries() mutation does not affect registry internal state', () => {
    registry.register(0, 'http://de-a:8000');
    const snap = registry.entries();
    snap.splice(0, snap.length); // mutate snapshot
    // Registry should still have the entry
    expect(registry.entries().length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit — overwrite-on-reregister (THE non-tautological test)
// ─────────────────────────────────────────────────────────────────────────────

describe('PendingRegistry — overwrite-on-reregister (non-tautological)', () => {
  afterEach(() => {
    // Registries created in each test are cleared inside the test
  });

  it('re-registering same subjectIdx clears the old TTL timer so it cannot evict the new URL', () => {
    // WHY this is non-tautological:
    // A naive implementation that does NOT clear the old timer on overwrite would have TWO
    // timers alive after re-registration: the old one (fires at delayA) and the new one
    // (fires at delayB). When we fire the OLD timer's ID manually, the naive impl would
    // delete the entry — resolving to undefined. The CORRECT impl cleared that old timer
    // handle on overwrite, so firing the old timer ID is a no-op (it was cancelled).
    // This test distinguishes them.

    const fake = makeFakeScheduler();
    // Use distinct large TTLs so we can control exactly which fires
    const registry = new PendingRegistry(999_999_999, fake.scheduler);

    // Step 1: Register subjectIdx=0 with URL_A → old timer T1 is set
    registry.register(0, 'http://url-a:8000');
    expect(fake.pendingCount()).toBe(1);

    // Capture the timer id that was just set by peeking via the scheduler's internal state.
    // We know it was assigned id=1 (first timer from this fake scheduler).
    // But since makeFakeScheduler is a fresh factory, the first id is always 1.
    // However, each test creates its own fake, so we capture the count BEFORE and AFTER.

    // Step 2: Re-register subjectIdx=0 with URL_B BEFORE old timer fires → overwrite
    registry.register(0, 'http://url-b:8001');

    // Resolve should now return URL_B
    expect(registry.resolve(0)).toBe('http://url-b:8001');

    // Step 3: Fire ALL pending timers with delay <= the original big TTL.
    // There should only be ONE pending timer (the new one), because the old one was cleared.
    // The new timer when fired will evict the entry.
    expect(fake.pendingCount()).toBe(1); // proves old timer was cleared

    // Step 4: Fire the SINGLE remaining timer (new one for URL_B).
    fake.fireAllBefore(999_999_999);

    // Now the entry should be evicted (TTL of new registration fired)
    expect(registry.resolve(0)).toBeUndefined();
    expect(registry.entries().length).toBe(0);

    registry.clearAll();
  });

  it('old timer fire does NOT evict newly-registered URL (proves timer was cancelled)', () => {
    // Use a fresh fake scheduler to track pending timer count precisely.
    // After overwrite: only ONE pending timer remains (the new one).
    // If the old timer was NOT cleared, TWO timers would be pending.
    const fake2 = makeFakeScheduler();
    const registry2 = new PendingRegistry(999_999_999, fake2.scheduler);

    // Register URL_A → timer id = 1 (first id in this fake)
    registry2.register(0, 'http://url-a:8000');
    const countAfterFirst = fake2.pendingCount();
    expect(countAfterFirst).toBe(1);

    // Register URL_B → this should CLEAR timer id=1 and set a new timer (id=2)
    registry2.register(0, 'http://url-b:8001');
    // Only ONE pending timer should remain (the NEW one), meaning old was cleared
    expect(fake2.pendingCount()).toBe(1);

    // Fire the one remaining timer → URL_B evicted (its own TTL)
    fake2.fireAllBefore(999_999_999);
    expect(registry2.resolve(0)).toBeUndefined();

    registry2.clearAll();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit — TTL eviction
// ─────────────────────────────────────────────────────────────────────────────

describe('PendingRegistry — TTL eviction', () => {
  it('entry is evicted after TTL timer fires', () => {
    const fake = makeFakeScheduler();
    const TTL_MS = 500;
    const registry = new PendingRegistry(TTL_MS, fake.scheduler);

    registry.register(0, 'http://de-a:8000');
    expect(registry.resolve(0)).toBe('http://de-a:8000');
    expect(registry.entries().length).toBe(1);

    // Fire timer with delay <= TTL_MS → should evict
    fake.fireAllBefore(TTL_MS);

    expect(registry.resolve(0)).toBeUndefined();
    expect(registry.entries().length).toBe(0);

    registry.clearAll();
  });

  it('entry is NOT evicted before TTL timer fires', () => {
    const fake = makeFakeScheduler();
    const TTL_MS = 500;
    const registry = new PendingRegistry(TTL_MS, fake.scheduler);

    registry.register(0, 'http://de-a:8000');

    // Fire timers with delay < TTL_MS (don't include TTL) → nothing evicted
    fake.fireAllBefore(TTL_MS - 1);

    expect(registry.resolve(0)).toBe('http://de-a:8000');
    expect(registry.entries().length).toBe(1);

    registry.clearAll();
  });

  it('clearAll() removes all entries and clears all timers', () => {
    const fake = makeFakeScheduler();
    const registry = new PendingRegistry(999_999_999, fake.scheduler);

    registry.register(0, 'http://de-a:8000');
    registry.register(1, 'http://de-b:8001');
    expect(registry.entries().length).toBe(2);
    expect(fake.pendingCount()).toBe(2);

    registry.clearAll();

    expect(registry.entries().length).toBe(0);
    expect(fake.pendingCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — /register route (supertest, createRegisterRouter directly)
// ─────────────────────────────────────────────────────────────────────────────

describe('/register route integration', () => {
  let registry: PendingRegistry;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    // Use a long TTL so entries don't expire during tests
    registry = new PendingRegistry(999_999_999);
    app = express();
    app.use(express.json());
    app.use('/', createRegisterRouter(registry, { engineSecret: TEST_SECRET }));
  });

  afterEach(() => {
    registry.clearAll();
  });

  it('POST / with correct secret + valid body → 200 {ok:true} + registry populated', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(registry.resolve(1)).toBe('http://de-a:8000');
  });

  it('POST / with wrong secret → 401', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', 'WRONG-SECRET')
      .send({ subject_idx: 0, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    // Registry should NOT have been updated
    expect(registry.resolve(0)).toBeUndefined();
  });

  it('POST / with missing secret header → 401', async () => {
    const res = await request(app).post('/').send({ subject_idx: 0, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('POST / with malformed body (missing de_url) → 400', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 0 });

    expect(res.status).toBe(400);
  });

  it('POST / with malformed body (non-integer subject_idx) → 400', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1.5, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(400);
  });

  it('POST / with malformed body (empty de_url string) → 400', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 0, de_url: '' });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security — M1 regression: empty engineSecret → fail-closed (auth-bypass-on-misconfig)
// ─────────────────────────────────────────────────────────────────────────────

describe('M1 regression — empty engineSecret fails closed (D14)', () => {
  it('/register with engineSecret="" and header x-engine-secret:"" → 401 (not 200)', async () => {
    // engineSecret defaults to '' when env is unset; a client sending an empty header
    // must NOT pass auth — the route must deny with 401 (fail-closed).
    const registry = new PendingRegistry(999_999_999);
    const app = express();
    app.use(express.json());
    // Explicitly pass empty string to simulate misconfigured/unset ENGINE_SECRET_KEY
    app.use('/', createRegisterRouter(registry, { engineSecret: '' }));

    const res = await request(app)
      .post('/')
      .set('x-engine-secret', '') // empty header — would pass the old check
      .send({ subject_idx: 0, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    // Registry must NOT have been populated
    expect(registry.resolve(0)).toBeUndefined();

    registry.clearAll();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — /control/assign-group route (PLAN-mandated: X-Engine-Secret + forward)
// ─────────────────────────────────────────────────────────────────────────────

describe('/control/assign-group route integration', () => {
  let registry: PendingRegistry;
  let app: ReturnType<typeof express>;
  let mockDeA: Awaited<ReturnType<typeof startMockDeServer>>;
  let mockDeB: Awaited<ReturnType<typeof startMockDeServer>>;

  beforeEach(async () => {
    registry = new PendingRegistry(999_999_999);
    mockDeA = await startMockDeServer(200);
    mockDeB = await startMockDeServer(200);

    app = express();
    app.use(express.json());
    app.use('/', createControlAssignGroupRouter(registry, { engineSecret: TEST_SECRET }));
  });

  afterEach(async () => {
    registry.clearAll();
    await mockDeA.close();
    await mockDeB.close();
  });

  it('POST / forwards to ALL registered DEs with X-Engine-Secret header (R1-9)', async () => {
    // Register two DEs
    registry.register(0, mockDeA.url);
    registry.register(1, mockDeB.url);

    const payload = { group_id: 'g1', extra: 'x' };

    const res = await request(app).post('/').set('x-engine-secret', TEST_SECRET).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.forwarded).toHaveLength(2);
    expect(res.body.forwarded.every((r: { ok: boolean }) => r.ok === true)).toBe(true);

    // Both mock DEs must have received a POST to /control/assign-group
    expect(mockDeA.captures).toHaveLength(1);
    expect(mockDeA.captures[0]!.method).toBe('POST');
    expect(mockDeA.captures[0]!.path).toBe('/control/assign-group');

    expect(mockDeB.captures).toHaveLength(1);
    expect(mockDeB.captures[0]!.method).toBe('POST');
    expect(mockDeB.captures[0]!.path).toBe('/control/assign-group');

    // Both must have received X-Engine-Secret header (node lowercases headers)
    expect(mockDeA.captures[0]!.headers['x-engine-secret']).toBe(TEST_SECRET);
    expect(mockDeB.captures[0]!.headers['x-engine-secret']).toBe(TEST_SECRET);

    // Bodies must be verbatim (ADR §C no mutation)
    expect(mockDeA.captures[0]!.body).toEqual(payload);
    expect(mockDeB.captures[0]!.body).toEqual(payload);
  });

  it('POST / with wrong inbound secret → 401, no DEs contacted', async () => {
    registry.register(0, mockDeA.url);

    const res = await request(app)
      .post('/')
      .set('x-engine-secret', 'WRONG-SECRET')
      .send({ group_id: 'g1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(mockDeA.captures).toHaveLength(0);
  });

  it('POST / with zero registered DEs → 200 {forwarded:[]}', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ group_id: 'g1' });

    expect(res.status).toBe(200);
    expect(res.body.forwarded).toEqual([]);
  });

  it('POST / with malformed body (missing group_id) → 400', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ other_field: 'x' });

    expect(res.status).toBe(400);
  });

  it('one DE server closed → route still 200, that entry ok:false, other ok:true (isolation)', async () => {
    // Use port 1 (refused) for the failing DE — do NOT close mockDeA so afterEach is safe.
    registry.register(0, 'http://localhost:1'); // port 1 will be connection-refused
    registry.register(1, mockDeB.url);

    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ group_id: 'g1' });

    expect(res.status).toBe(200);
    const fwds: Array<{ subjectIdx: number; ok: boolean; error?: string }> = res.body.forwarded;
    expect(fwds).toHaveLength(2);

    const failedEntry = fwds.find((f) => f.subjectIdx === 0);
    const succeededEntry = fwds.find((f) => f.subjectIdx === 1);

    expect(failedEntry?.ok).toBe(false);
    expect(succeededEntry?.ok).toBe(true);
    expect(mockDeB.captures).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat — createApp() still serves GET /health 200 {status:'ok'}
// ─────────────────────────────────────────────────────────────────────────────

describe('createApp() backward-compat — /health', () => {
  it('createApp() with no args → GET /health 200 {status:"ok"}', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('createApp() registers /register and /control/assign-group routes', async () => {
    const app = createApp();

    // /register without secret should get 401 (route is wired), not 404
    const regRes = await request(app)
      .post('/register')
      .send({ subject_idx: 0, de_url: 'http://de-a:8000' });
    expect(regRes.status).toBe(401); // unauthorized (no secret), not 404

    // /control/assign-group without secret should get 401, not 404
    const assignRes = await request(app).post('/control/assign-group').send({ group_id: 'g1' });
    expect(assignRes.status).toBe(401); // unauthorized (no secret), not 404
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit — PendingRegistry onEvict hook
// ─────────────────────────────────────────────────────────────────────────────

describe('PendingRegistry — onEvict hook', () => {
  it('onEvict 주입 + TTL 만료 fire → onEvict 1회', () => {
    const fake = makeFakeScheduler();
    const onEvict = vi.fn();
    const reg = new PendingRegistry(500, fake.scheduler, onEvict);

    reg.register(1, 'http://de-a:8000');
    fake.fireAllBefore(500);

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith(1, 'http://de-a:8000');

    reg.clearAll();
  });

  it('onEvict 미주입 (2-arg ctor) + TTL fire → crash 없음, entry evicted', () => {
    const fake = makeFakeScheduler();
    // No onEvict argument: existing 2-arg constructor call
    const reg = new PendingRegistry(500, fake.scheduler);

    reg.register(1, 'http://de-a:8000');
    expect(reg.resolve(1)).toBe('http://de-a:8000');

    expect(() => fake.fireAllBefore(500)).not.toThrow();

    // Entry evicted by TTL
    expect(reg.resolve(1)).toBeUndefined();
    expect(reg.entries().length).toBe(0);

    reg.clearAll();
  });

  it('overwrite-on-reregister: urlA timer cleared, onEvict called once with urlB', () => {
    const fake = makeFakeScheduler();
    const onEvict = vi.fn();
    const reg = new PendingRegistry(500, fake.scheduler, onEvict);

    // Register urlA → timer T1
    reg.register(1, 'http://url-a:8000');

    // Overwrite with urlB → T1 cleared, new timer T2 set
    reg.register(1, 'http://url-b:8001');

    // Only one pending timer remains (T2 for urlB; T1 was cleared)
    expect(fake.pendingCount()).toBe(1);

    // Fire remaining timer → onEvict called once for urlB
    fake.fireAllBefore(500);

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith(1, 'http://url-b:8001');
    // urlA timer was cleared so onEvict was NOT called with urlA
    expect(onEvict).not.toHaveBeenCalledWith(1, 'http://url-a:8000');

    reg.clearAll();
  });

  it('manual unregister(1) 후 timer fire 시 onEvict 미호출', () => {
    const fake = makeFakeScheduler();
    const onEvict = vi.fn();
    const reg = new PendingRegistry(500, fake.scheduler, onEvict);

    reg.register(1, 'http://de-a:8000');
    // Manually unregister (clears timer)
    reg.unregister(1);

    // No pending timer remains
    expect(fake.pendingCount()).toBe(0);

    // Attempting to fire would be a no-op, but try anyway
    fake.fireAllBefore(500);

    expect(onEvict).not.toHaveBeenCalled();

    reg.clearAll();
  });

  it('clearAll() 후 fire → onEvict 미호출', () => {
    const fake = makeFakeScheduler();
    const onEvict = vi.fn();
    const reg = new PendingRegistry(500, fake.scheduler, onEvict);

    reg.register(1, 'http://de-a:8000');
    reg.register(2, 'http://de-b:8001');

    // clearAll cancels all timers
    reg.clearAll();

    expect(fake.pendingCount()).toBe(0);

    // Even if we try to fire, nothing is left
    fake.fireAllBefore(500);

    expect(onEvict).not.toHaveBeenCalled();
  });

  it('R2-6 runtime narrow via onEvict guard: subjectIdx 0 narrowed out, 2 passes through', () => {
    const fake = makeFakeScheduler();
    const spy = vi.fn();

    // Narrow: only call spy for subjectIdx 1 or 2
    const reg = new PendingRegistry(500, fake.scheduler, (i: number, u: string) => {
      if (i !== 1 && i !== 2) return;
      spy(i, u);
    });

    // Register subjectIdx=0 (should be narrowed out)
    reg.register(0, 'http://x:8000');
    fake.fireAllBefore(500);

    // spy NOT called for idx 0
    expect(spy).not.toHaveBeenCalled();
    // But the entry IS evicted from the registry
    expect(reg.resolve(0)).toBeUndefined();

    // Register subjectIdx=2 (should pass through)
    reg.register(2, 'http://y:8001');
    fake.fireAllBefore(500);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2, 'http://y:8001');

    reg.clearAll();
  });
});
