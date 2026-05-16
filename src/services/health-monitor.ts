import { config } from '../config';

/**
 * HealthMonitor — heartbeat sender and fail-closed signal for the proxy.
 *
 * The proxy is a SPOF: if it cannot sustain a heartbeat, downstream consumers
 * (BE, DE_B) poll `/health` and should trip fail-closed.  This class tracks
 * the last beat timestamp via an injected high-resolution clock so that tests
 * can drive the lifecycle deterministically without real timers.
 *
 * Design mirrors BeForwarder._startDrainLoop / _stopDrainLoop for idempotent
 * interval management, and PairBuffer's BigInt discipline for ns arithmetic.
 */
export class HealthMonitor {
  private readonly heartbeatIntervalMs: number;
  private readonly failClosedThresholdNs: bigint;
  private readonly clock: () => bigint;

  /** Timer handle — null means not running. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Timestamp of the most recent beat (bigint ns), or undefined if never beaten. */
  private _lastBeatNs: bigint | undefined = undefined;

  /** Whether a "stall" warn has already been emitted for the current stall run. */
  private _stallWarnEmitted = false;

  /**
   * @param heartbeatIntervalMs  Milliseconds between automatic beats when started.
   *                              Defaults to config.HEARTBEAT_INTERVAL_MS.
   * @param failClosedThresholdMs Milliseconds without a beat before isHealthy() → false.
   *                              Defaults to config.FAIL_CLOSED_THRESHOLD_MS.
   * @param clock                 Injectable high-resolution clock returning bigint nanoseconds.
   *                              Defaults to process.hrtime.bigint for production use.
   */
  constructor(
    heartbeatIntervalMs: number = config.HEARTBEAT_INTERVAL_MS,
    failClosedThresholdMs: number = config.FAIL_CLOSED_THRESHOLD_MS,
    clock: () => bigint = () => process.hrtime.bigint(),
  ) {
    // Defense-in-depth assertion: complements the config.ts process-level guard and
    // is directly testable when using injected values that bypass config.ts.
    if (failClosedThresholdMs <= heartbeatIntervalMs) {
      throw new Error(
        `HealthMonitor: failClosedThresholdMs (${failClosedThresholdMs}) must be > heartbeatIntervalMs (${heartbeatIntervalMs})`,
      );
    }

    this.heartbeatIntervalMs = heartbeatIntervalMs;
    // Convert ms → ns using BigInt to avoid floating-point imprecision (mirrors PairBuffer.windowNs).
    this.failClosedThresholdNs = BigInt(failClosedThresholdMs) * 1_000_000n;
    this.clock = clock;
  }

  /**
   * Start the periodic heartbeat interval.
   * Idempotent: a second call while already running is a no-op (mirrors _startDrainLoop).
   */
  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      this.beat();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop the periodic heartbeat interval.
   * Idempotent: safe to call before start() or multiple times.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Record a heartbeat at the current clock time.
   * Also called internally by the interval; public so tests can drive it
   * deterministically without real timers.
   */
  beat(): void {
    this._lastBeatNs = this.clock();
    // A new beat recovers from stall — allow the next stall to emit a fresh warn.
    this._stallWarnEmitted = false;
  }

  /**
   * Returns true iff the monitor has beaten at least once AND the time since the
   * last beat does not exceed failClosedThresholdMs (fail-closed when stalled).
   *
   * Transition: on the first call that detects healthy → unhealthy, emits ONE
   * structured console.warn (does not spam on subsequent calls while still stalled).
   */
  isHealthy(): boolean {
    if (this._lastBeatNs === undefined) {
      // Never beaten — fail-closed
      return false;
    }

    const nowNs = this.clock();
    const elapsedNs = nowNs - this._lastBeatNs;
    const healthy = elapsedNs <= this.failClosedThresholdNs;

    if (!healthy && !this._stallWarnEmitted) {
      this._stallWarnEmitted = true;
      console.warn('[HealthMonitor] heartbeat stalled — fail-closed signal', {
        elapsedMs: Number(elapsedNs / 1_000_000n),
        thresholdMs: Number(this.failClosedThresholdNs / 1_000_000n),
        lastBeatNs: this._lastBeatNs.toString(),
      });
    }

    return healthy;
  }

  /**
   * Inspection helper: returns the nanosecond timestamp of the last beat,
   * or undefined if beat() has never been called.
   */
  lastBeatNs(): bigint | undefined {
    return this._lastBeatNs;
  }
}
