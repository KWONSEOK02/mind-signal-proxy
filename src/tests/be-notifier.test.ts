import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BeNotifier } from '../services/be-notifier';

const TEST_SECRET = 'test-engine-secret-xyz';
const BACKEND_URL = 'http://be-test:9000';

// Per-attempt timeout injected as very large so it never fires or interferes during tests.
// Backoff delays are 1000ms (attempt 0) and 2000ms (attempt 1).
// The fake timer below intercepts ALL setTimer calls.  BeNotifier calls global clearTimeout
// with our fake numeric handles, which is a no-op in Node — that is fine because we identify
// and skip timeout-type timers by their large ms value.
const TEST_TIMEOUT_MS = 999_999_999;
// Max backoff delay in a 3-attempt run is 2000ms (1000 * 2^1).  Any timer <= MAX_BACKOFF_MS
// is a backoff timer; any timer > MAX_BACKOFF_MS is a per-attempt timeout timer.
const MAX_BACKOFF_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Fake setTimer: records all scheduled callbacks, exposes selective firing.
// Returns a plain numeric handle so global clearTimeout(number) is a safe no-op.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeTimerEntry {
  id: number;
  ms: number;
  cb: () => void;
}

function makeFakeTimer(): {
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  entries: () => FakeTimerEntry[];
  /** Fire all pending timers regardless of delay. */
  fireAll: () => void;
  /** Fire the first pending backoff timer (delay <= MAX_BACKOFF_MS). */
  fireFirstBackoff: () => void;
  /** Fire all pending backoff timers (delay <= MAX_BACKOFF_MS). */
  fireAllBackoffs: () => void;
  /** Number of pending timers in total (backoff + timeout). */
  pendingCount: () => number;
  /** Number of pending backoff timers (delay <= MAX_BACKOFF_MS). */
  backoffCount: () => number;
  /** Recorded ms values for all timer entries in insertion order. */
  recordedMs: () => number[];
} {
  const pending: Map<number, FakeTimerEntry> = new Map();
  let nextId = 100; // start far from real timer ids

  function setTimer(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = nextId++;
    pending.set(id, { id, ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  const isBackoff = (e: FakeTimerEntry) => e.ms <= MAX_BACKOFF_MS;

  return {
    setTimer,
    entries: () => [...pending.values()],
    fireAll(): void {
      const toFire = [...pending.values()];
      for (const entry of toFire) {
        pending.delete(entry.id);
        entry.cb();
      }
    },
    fireFirstBackoff(): void {
      const entry = [...pending.values()].find(isBackoff);
      if (entry) {
        pending.delete(entry.id);
        entry.cb();
      }
    },
    fireAllBackoffs(): void {
      const toFire = [...pending.values()].filter(isBackoff);
      for (const entry of toFire) {
        pending.delete(entry.id);
        entry.cb();
      }
    },
    pendingCount(): number {
      return pending.size;
    },
    backoffCount(): number {
      return [...pending.values()].filter(isBackoff).length;
    },
    recordedMs(): number[] {
      return [...pending.values()].map((e) => e.ms);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create a BeNotifier with deterministic deps
// ─────────────────────────────────────────────────────────────────────────────

function makeBeNotifier(overrides: {
  fetchFn?: typeof fetch;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  backendUrl?: string;
  engineSecret?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}): BeNotifier {
  const notifier = new BeNotifier({
    backendUrl: overrides.backendUrl ?? BACKEND_URL,
    engineSecret: overrides.engineSecret ?? TEST_SECRET,
    fetchFn: overrides.fetchFn,
    setTimer: overrides.setTimer,
    maxAttempts: overrides.maxAttempts ?? 3,
    // Use TEST_TIMEOUT_MS (999_999_999) so per-attempt timeout never fires.
    // Global clearTimeout with our fake handle is a no-op, leaving these in the
    // fake map — but since they have ms=999_999_999 > MAX_BACKOFF_MS, fireFirstBackoff
    // and fireAllBackoffs skip them entirely.
    timeoutMs: overrides.timeoutMs ?? TEST_TIMEOUT_MS,
  });
  // R2-2/R4-1: track latest instance so the suite afterEach can defensively
  // abortAll even if a mid-test assertion throws before the inline abortAll.
  activeNotifier = notifier;
  return notifier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console spies — set up fresh per test
// ─────────────────────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// R2-2/R4-1: latest BeNotifier created via makeBeNotifier — abortAll in afterEach
// guarantees timer/fetch teardown even when a mid-test assertion throws.
let activeNotifier: BeNotifier | undefined;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // abortAll is terminal and idempotent — safe even if the test already called it.
  activeNotifier?.abortAll();
  activeNotifier = undefined;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('BeNotifier', () => {
  // ───────────────────────── 200 happy path ─────────────────────────
  it('200 happy: notifyRegister resolves ok state and emits log', async () => {
    const fake = makeFakeTimer();
    const engineUrl = 'http://de-a:8000';

    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl });

    await vi.waitFor(() =>
      expect(
        logSpy.mock.calls.some((a) => String(a[0]).includes('[be-notifier] register notify ok')),
      ).toBe(true),
    );

    // fetch called exactly once
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // method POST
    const [calledUrl, calledInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BACKEND_URL}/api/engine/register-pending`);
    expect(calledInit.method).toBe('POST');
    expect((calledInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    // body shape
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body).toEqual({ subjectIndex: 1, engineUrl, secretKey: TEST_SECRET });

    // log string check — mirrors the exact console.log in be-notifier.ts line 216
    const anyLogMatch = logSpy.mock.calls.some((args) =>
      String(args[0]).includes('[be-notifier] register notify ok subjectIndex=1 url='),
    );
    expect(anyLogMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── 5xx exhausted ─────────────────────────
  it('5xx 3회 시도 후 exhausted', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 3 });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // Wait for first attempt to complete (fetchFn called once, backoff timer scheduled)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    // First backoff timer should now be recorded (delay = 1000ms = 1000 * 2^0)
    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    const firstBackoffMs = fake.entries().find((e) => e.ms <= MAX_BACKOFF_MS)!.ms;

    // Fire first backoff timer
    fake.fireFirstBackoff();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    // Second backoff timer should now be recorded (delay = 2000ms = 1000 * 2^1)
    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    const secondBackoffMs = fake.entries().find((e) => e.ms <= MAX_BACKOFF_MS)!.ms;

    // Fire second backoff timer
    fake.fireFirstBackoff();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=exhausted'))).toBe(true),
    );

    // assert delay sequence: 1000 then 2000
    expect(firstBackoffMs).toBe(1000);
    expect(secondBackoffMs).toBe(2000);

    // console.error with reason=exhausted
    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=exhausted'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── BE-late (503 then 200) ─────────────────────────
  it('BE-late(첫 503 후 200) ok', async () => {
    const fake = makeFakeTimer();
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response('{}', { status: 503 }));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 3 });
    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // Wait for first fetch (503)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    // Fire first backoff to trigger second attempt
    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();

    await vi.waitFor(() =>
      expect(
        logSpy.mock.calls.some((a) => String(a[0]).includes('[be-notifier] register notify ok')),
      ).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);

    beNotifier.abortAll();
  });

  // ───────────────────────── 403 immediate failed ─────────────────────────
  it('403 즉시 failed reason=http_403, fetch 1회, backoff 미발생', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=http_403'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=http_403'),
    );
    expect(anyErrorMatch).toBe(true);

    // No backoff timer scheduled (only the per-attempt timeout timer at 999_999_999ms, skipped)
    expect(fake.backoffCount()).toBe(0);

    beNotifier.abortAll();
  });

  // ───────────────────────── 400 immediate failed ─────────────────────────
  it('400 즉시 failed reason=http_400, fetch 1회', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=http_400'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=http_400'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── 404 immediate failed ─────────────────────────
  it('404 즉시 failed reason=http_404, fetch 1회', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=http_404'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=http_404'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── 422 immediate failed ─────────────────────────
  it('422 즉시 failed reason=http_422, fetch 1회', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 422 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=http_422'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=http_422'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── 429 retryable ─────────────────────────
  it('429 retryable: 3회 시도 후 exhausted', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 3 });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();
    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=exhausted'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(3);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=exhausted'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── transport throw (network error) ─────────────────────────
  it('transport throw (network TypeError): 3회 retryable 후 exhausted', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('network'));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 3 });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();
    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=exhausted'))).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(3);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=exhausted'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── TimeoutError is retryable (R2-8) ─────────────────────────
  it('timeout classification (R2-8): TimeoutError retryable, maxAttempts=2 에서 exhausted', async () => {
    const fake = makeFakeTimer();
    // fetch rejects with a TimeoutError DOMException (not an AbortError)
    const fetchFn = vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    const beNotifier = makeBeNotifier({
      fetchFn,
      setTimer: fake.setTimer,
      maxAttempts: 2,
    });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    // fire the backoff for the first attempt
    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));
    fake.fireFirstBackoff();

    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=exhausted'))).toBe(true),
    );

    // maxAttempts=2 means two total fetch calls then exhausted
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=exhausted'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── backendUrl='' (CX-1) ─────────────────────────
  it("backendUrl='' (CX-1): fetch 미호출, failed reason=missing_backend_url", async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn();
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, backendUrl: '' });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    await vi.waitFor(() =>
      expect(
        errorSpy.mock.calls.some((a) => String(a[0]).includes('reason=missing_backend_url')),
      ).toBe(true),
    );

    expect(fetchFn).toHaveBeenCalledTimes(0);

    const anyErrorMatch = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('reason=missing_backend_url'),
    );
    expect(anyErrorMatch).toBe(true);

    beNotifier.abortAll();
  });

  // ───────────────────────── CX3-1 serialization / latest-wins ─────────────────────────
  it('CX3-1 serialization: 두 번째 notify는 첫 in-flight 완료 후 처리, latest-wins', async () => {
    const fake = makeFakeTimer();

    // First fetch: controllable deferred promise
    let resolveFirstFetch!: (r: Response) => void;
    const firstFetchPromise = new Promise<Response>((res) => {
      resolveFirstFetch = res;
    });

    let fetchCallCount = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) return firstFetchPromise;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    // Kick off first notify
    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://a:8000' });

    // Give the event loop a tick so the first fetch starts
    await Promise.resolve();
    await Promise.resolve();

    // Assert first fetch is in-flight
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Enqueue second notify while first fetch is still in-flight
    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://b:8000' });

    // Second fetch must NOT have started yet (serialized)
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Resolve first fetch as 200
    resolveFirstFetch(new Response('{}', { status: 200 }));

    // Now second op should run and fetchFn called again with the B url
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    // Final fetch body must reference engineUrl 'http://b:8000' (latest-wins)
    const lastCallArgs = fetchFn.mock.calls[1] as [string, RequestInit];
    const lastBody = JSON.parse(lastCallArgs[1].body as string) as Record<string, unknown>;
    expect(lastBody.engineUrl).toBe('http://b:8000');

    await vi.waitFor(() =>
      expect(
        logSpy.mock.calls.some((a) => String(a[0]).includes('[be-notifier] register notify ok')),
      ).toBe(true),
    );

    beNotifier.abortAll();
  });

  // ───────────────────────── register then unregister coalescing ─────────────────────────
  it('register 후 unregister coalescing: in-flight 중 DELETE enqueue, 최종 BE fetch는 DELETE', async () => {
    const fake = makeFakeTimer();

    let resolveFirstFetch!: (r: Response) => void;
    const firstFetchPromise = new Promise<Response>((res) => {
      resolveFirstFetch = res;
    });

    let fetchCallCount = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) return firstFetchPromise;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // give a tick so first fetch starts
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchFn).toHaveBeenCalledTimes(1);

    // enqueue unregister while POST is in-flight
    beNotifier.notifyUnregister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // resolve first fetch
    resolveFirstFetch(new Response('{}', { status: 200 }));

    // wait for second fetch (the DELETE)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    const [, deleteInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(deleteInit.method).toBe('DELETE');

    beNotifier.abortAll();
  });

  // ───────────────────────── DELETE shape ─────────────────────────
  it('DELETE shape: notifyUnregister fetch는 method=DELETE, body에 engineUrl 포함', async () => {
    const fake = makeFakeTimer();
    const engineUrl = 'http://de-a:8000';
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyUnregister({ subjectIndex: 1, engineUrl });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    const [calledUrl, calledInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BACKEND_URL}/api/engine/register-pending`);
    expect(calledInit.method).toBe('DELETE');

    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.engineUrl).toBe(engineUrl);
    expect(body.secretKey).toBe(TEST_SECRET);
    expect(body.subjectIndex).toBe(1);

    beNotifier.abortAll();
  });

  // ───────────────────────── fire-and-forget no unhandledRejection ─────────────────────────
  it('fire-and-forget no unhandledRejection', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('network'));
    // maxAttempts=1 so it fails immediately without needing to fire backoffs
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 1 });

    const handler = vi.fn();
    process.once('unhandledRejection', handler);

    try {
      beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

      // drain microtasks
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', handler);
      beNotifier.abortAll();
    }
  });

  // ───────────────────────── R4-1 abortAll during backoff ─────────────────────────
  it('R4-1 abortAll-during-backoff: backoff 중 abortAll 후 loop settle, 추가 fetch 없음', async () => {
    const fake = makeFakeTimer();
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer, maxAttempts: 3 });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // wait for first attempt to complete (state becomes 'pending' while awaiting backoff)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    // backoff timer is recorded but NOT fired yet
    await vi.waitFor(() => expect(fake.backoffCount()).toBeGreaterThanOrEqual(1));

    const fetchCountBeforeAbort = fetchFn.mock.calls.length;

    // abortAll while in backoff: this sets closed=true, calls backoffResolvers to unblock the await,
    // and fires the backoff promise resolver so the loop exits via closed guard
    beNotifier.abortAll();

    // fire any remaining fake timer entries (they should be no-ops because closed=true)
    fake.fireAll();

    // give microtasks a moment to drain
    await new Promise<void>((r) => setTimeout(r, 0));
    await Promise.resolve();

    // no additional fetch after abortAll
    expect(fetchFn).toHaveBeenCalledTimes(fetchCountBeforeAbort);
  });

  // ───────────────────────── R4-1 abortAll during fetch ─────────────────────────
  it('R4-1 abortAll-during-fetch: signal abort 시 retry 없음, loop settle', async () => {
    const fake = makeFakeTimer();

    // fetch blocks until signal aborts, then rejects with AbortError
    const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      });
    });

    const beNotifier = makeBeNotifier({ fetchFn, setTimer: fake.setTimer });

    beNotifier.notifyRegister({ subjectIndex: 1, engineUrl: 'http://de-a:8000' });

    // give a tick so the fetch starts
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchFn).toHaveBeenCalledTimes(1);

    // abort while fetch is in-flight
    beNotifier.abortAll();

    // drain microtasks
    await new Promise<void>((r) => setTimeout(r, 0));
    await Promise.resolve();

    // no retry: fetch called only once
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
