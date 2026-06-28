import { config } from '../config';

/**
 * PendingRegistry — in-memory DE URL registry for the proxy.
 *
 * Tracks the mapping from subjectIdx → DE URL for active pending subjects.
 * DEs self-register by POSTing to the proxy's /register endpoint; BE queries
 * the proxy's /control/assign-group endpoint which fans out to all registered DEs.
 *
 * TTL semantics: each entry is automatically evicted after ttlMs to prevent
 * stale registrations from accumulating (R2-6 / PENDING_REGISTRY_TTL_MS env).
 *
 * Overwrite-on-reregister: if a subjectIdx is already registered, the old TTL
 * timer is CLEARED before writing the new URL so the old timer cannot evict
 * the newly-registered URL.
 *
 * Design mirrors HealthMonitor: ctor DI for ttlMs and scheduler (injectable for
 * deterministic tests without real timers).
 */
export class PendingRegistry {
  private readonly ttlMs: number;
  private readonly scheduler: {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };

  /** Per-entry store: subjectIdx → { deUrl, timer handle }. */
  private readonly entries_: Map<
    number,
    { deUrl: string; timer: ReturnType<typeof globalThis.setTimeout> }
  > = new Map();

  /**
   * @param ttlMs      Milliseconds until an entry is automatically evicted.
   *                   Defaults to config.PENDING_REGISTRY_TTL_MS.
   * @param scheduler  Injectable timer provider.  Defaults to globalThis (real timers).
   *                   Inject a fake scheduler in tests for deterministic TTL control.
   * @param onEvict    Optional hook called only on TTL-expiry eviction with the
   *                   evicted subjectIdx and the original deUrl.  Not called on
   *                   overwrite-on-reregister, unregister(), or clearAll().
   */
  constructor(
    ttlMs: number = config.PENDING_REGISTRY_TTL_MS,
    scheduler: {
      setTimeout: typeof globalThis.setTimeout;
      clearTimeout: typeof globalThis.clearTimeout;
    } = globalThis,
    private readonly onEvict?: (subjectIdx: number, deUrl: string) => void, // 신규: TTL 만료 evict 시에만 호출
  ) {
    this.ttlMs = ttlMs;
    this.scheduler = scheduler;
  }

  /**
   * Register (or overwrite) a DE URL for the given subjectIdx.
   *
   * Overwrite semantics: if an entry already exists for subjectIdx, the old
   * TTL timer is cleared first so it cannot evict the newly-registered URL.
   * A fresh TTL timer is then set for the new entry.
   */
  register(subjectIdx: number, deUrl: string): void {
    // Overwrite-on-reregister: clear old timer if present to prevent stale eviction.
    const existing = this.entries_.get(subjectIdx);
    if (existing !== undefined) {
      this.scheduler.clearTimeout(existing.timer);
    }

    // Set a fresh TTL timer for this entry.
    const timer = this.scheduler.setTimeout(() => {
      this.entries_.delete(subjectIdx);
      this.onEvict?.(subjectIdx, deUrl); // 신규: 원본 deUrl 전달 (BE URL-match 가드 통과용)
    }, this.ttlMs);

    this.entries_.set(subjectIdx, { deUrl, timer });
  }

  /**
   * Resolve the DE URL for a given subjectIdx.
   * Returns undefined if no entry exists (never registered, or evicted by TTL).
   */
  resolve(subjectIdx: number): string | undefined {
    return this.entries_.get(subjectIdx)?.deUrl;
  }

  /**
   * Manually remove an entry and clear its TTL timer.
   * No-op if the subjectIdx is not registered.
   */
  unregister(subjectIdx: number): void {
    const existing = this.entries_.get(subjectIdx);
    if (existing !== undefined) {
      this.scheduler.clearTimeout(existing.timer);
      this.entries_.delete(subjectIdx);
    }
  }

  /**
   * Returns a snapshot of all currently registered entries.
   * Mutations to the returned array do not affect the registry.
   */
  entries(): Array<{ subjectIdx: number; deUrl: string }> {
    return [...this.entries_.entries()].map(([subjectIdx, { deUrl }]) => ({ subjectIdx, deUrl }));
  }

  /**
   * Clear all entries and cancel all pending TTL timers.
   * Primarily for test cleanup — prevents leaked timer handles.
   */
  clearAll(): void {
    for (const { timer } of this.entries_.values()) {
      this.scheduler.clearTimeout(timer);
    }
    this.entries_.clear();
  }
}
