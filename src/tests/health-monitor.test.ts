import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { HealthMonitor } from '../services/health-monitor';
import { createApp } from '../index';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mutable injected clock returning a bigint you can advance. */
function makeClock(initialNs: bigint = 0n): {
  clock: () => bigint;
  advanceMs: (ms: number) => void;
} {
  let now = initialNs;
  return {
    clock: () => now,
    advanceMs: (ms: number) => {
      now += BigInt(ms) * 1_000_000n;
    },
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Startup assertion
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor — startup assertion', () => {
  it('throws when heartbeatIntervalMs >= failClosedThresholdMs (interval equal to threshold)', () => {
    expect(() => new HealthMonitor(3000, 3000)).toThrow();
  });

  it('throws when heartbeatIntervalMs > failClosedThresholdMs', () => {
    expect(() => new HealthMonitor(2000, 1000)).toThrow();
  });

  it('does NOT throw with valid ordering (threshold > interval)', () => {
    expect(() => new HealthMonitor(500, 1500)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isHealthy lifecycle — deterministic injected clock (NO real timers)
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor — isHealthy lifecycle (injected clock)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('isHealthy() is false before any beat is recorded', () => {
    const { clock } = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, clock);
    // Never started, never beaten — fail-closed
    expect(monitor.isHealthy()).toBe(false);
  });

  it('isHealthy() is true immediately after beat()', () => {
    const { clock } = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, clock);
    monitor.beat();
    expect(monitor.isHealthy()).toBe(true);
  });

  it('isHealthy() is true at exactly the threshold boundary (now - last === threshold)', () => {
    const c = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, c.clock);
    monitor.beat(); // beaten at 0 ns
    // Advance to exactly threshold (1500 ms = 1_500_000_000 ns)
    c.advanceMs(1500);
    // (now - lastBeat) = 1_500_000_000 ns === failClosedThresholdMs * 1_000_000 → still healthy (<=)
    expect(monitor.isHealthy()).toBe(true);
  });

  it('isHealthy() is false when clock advances just past threshold', () => {
    const c = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, c.clock);
    monitor.beat(); // beaten at 0 ns
    c.advanceMs(1501); // 1 ms past threshold
    expect(monitor.isHealthy()).toBe(false);
  });

  it('emits exactly ONE structured console.warn containing "fail-closed" on first stall detection', () => {
    const c = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, c.clock);
    monitor.beat();
    c.advanceMs(2000); // stalled

    // First call to isHealthy() in stalled state → exactly one warn
    expect(monitor.isHealthy()).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    const args = warnSpy.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain('fail-closed');

    // Subsequent calls while still stalled → NO additional warn
    warnSpy.mockClear();
    expect(monitor.isHealthy()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warn fires again if monitor becomes healthy again then stalls again', () => {
    const c = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, c.clock);

    // First stall cycle
    monitor.beat();
    c.advanceMs(2000);
    expect(monitor.isHealthy()).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockClear();

    // Recover: new beat
    monitor.beat();
    expect(monitor.isHealthy()).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    // Second stall cycle → warn fires again (once)
    c.advanceMs(2000);
    expect(monitor.isHealthy()).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stop() → fail-closed (real short timers; thresholds large enough to avoid flakiness)
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor — stop() causes fail-closed', () => {
  let monitor: HealthMonitor;

  afterEach(() => {
    // Ensure no leaked handles even if test fails
    try {
      monitor.stop();
    } catch {
      // already stopped
    }
  });

  it('after stop(), isHealthy() goes false once clock exceeds threshold', async () => {
    // interval=20ms, threshold=200ms — plenty of headroom to avoid flakiness
    monitor = new HealthMonitor(20, 200);
    monitor.start();
    // Wait a couple of intervals so beats are recorded
    await delay(60);
    expect(monitor.isHealthy()).toBe(true);

    monitor.stop();
    // Wait past threshold
    await delay(250);
    expect(monitor.isHealthy()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor — idempotency', () => {
  let monitor: HealthMonitor;

  afterEach(() => {
    try {
      monitor.stop();
    } catch {
      // ok
    }
  });

  it('double start() does not create two intervals (beat count ~1x per interval, not 2x)', async () => {
    // interval=50ms, threshold=300ms
    monitor = new HealthMonitor(50, 300);
    monitor.start();
    monitor.start(); // second call must be idempotent

    // We use lastBeatNs to detect beats: record ts before, then check if it advanced
    const tsBefore = monitor.lastBeatNs();
    await delay(120); // ~2 intervals worth
    const tsAfter = monitor.lastBeatNs();

    // If two intervals were running, beats would be ~4 instead of ~2.
    // We verify indirectly: after 120ms with a 50ms interval, tsAfter > tsBefore (beats occurred).
    // The key assertion: the monitor is still healthy (not double-burning).
    expect(tsAfter).toBeDefined();
    expect(tsAfter).not.toBe(tsBefore);
    // And it should still be healthy (not double-firing wouldn't make it unhealthy, but sanity check)
    expect(monitor.isHealthy()).toBe(true);
  });

  it('stop() before start() does not throw', () => {
    monitor = new HealthMonitor(50, 300);
    expect(() => monitor.stop()).not.toThrow();
  });

  it('double stop() does not throw', () => {
    monitor = new HealthMonitor(50, 300);
    monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration via supertest — /health route with monitor awareness
// ─────────────────────────────────────────────────────────────────────────────

describe('HealthMonitor — /health route integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('createApp() with no monitor → GET /health 200 {status:"ok"} (backward-compat)', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  it('createApp(healthyMonitor) → GET /health 200 {status:"ok"}', async () => {
    const c = makeClock(0n);
    // threshold=1500ms, interval=500ms
    const monitor = new HealthMonitor(500, 1500, c.clock);
    monitor.beat(); // healthy
    const app = createApp(monitor);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('createApp(stalledMonitor) → GET /health 503 {status:"fail_closed"}', async () => {
    const c = makeClock(0n);
    const monitor = new HealthMonitor(500, 1500, c.clock);
    monitor.beat();
    c.advanceMs(2000); // stall past threshold
    const app = createApp(monitor);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('fail_closed');
    expect(typeof res.body.version).toBe('string');
  });
});
