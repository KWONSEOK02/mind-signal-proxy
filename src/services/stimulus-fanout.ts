/** The stimulus event forwarded verbatim from BE. Proxy never mutates it (ADR §C). */
export interface StimulusEvent {
  groupId: string;
  timestamp_ms: number;
}

/** A single fan-out destination (one DE). */
export interface FanoutTarget {
  readonly id: string; // stable identity (e.g. DE URL or subject key)
  readonly kind: 'loopback' | 'http'; // DE_A=loopback (operator PC), DE_B=http (LAN) — informational
  deliver(event: StimulusEvent): Promise<void>; // resolves=accepted, rejects=failed
}

/** Per-target outcome of a broadcast. */
export interface FanoutResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * StimulusFanout — concurrent stimulus broadcaster to multiple DE targets.
 *
 * ADR §C invariant: forward/fan-out ONLY — this class performs NO canonical
 * alignment and MUST NOT mutate the stimulus payload. The same event object
 * reference is passed verbatim to every registered target.
 *
 * Fan-out semantics:
 *  - All targets are dispatched concurrently (same tick) via Promise.allSettled.
 *    A sequential for…await is explicitly avoided to guarantee ≤5 ms start-time
 *    spread between targets on LAN-local transport.
 *  - Per-target failure is isolated: one DE timing-out / rejecting does NOT block
 *    or cancel delivery to any other DE (R1 invariant).
 *  - Targets are managed as a Map keyed by id; addTarget on an existing id
 *    overwrites the previous instance (overwrite-on-same-id semantics).
 */
export class StimulusFanout {
  /** Fan-out targets keyed by stable id. */
  private readonly targets: Map<string, FanoutTarget> = new Map();

  // ──────────────────────────────────────────────────────────────────────────
  // Target management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a delivery target.
   * If a target with the same id already exists it is replaced (overwrite-on-same-id).
   */
  addTarget(target: FanoutTarget): void {
    this.targets.set(target.id, target);
  }

  /**
   * Unregister a delivery target by id.
   * No-op if the id is not present.
   */
  removeTarget(targetId: string): void {
    this.targets.delete(targetId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inspection helpers (used by tests)
  // ──────────────────────────────────────────────────────────────────────────

  /** Number of currently registered targets. */
  targetCount(): number {
    return this.targets.size;
  }

  /** Ids of all currently registered targets (insertion order). */
  getTargetIds(): string[] {
    return [...this.targets.keys()];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Broadcast
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Broadcast a stimulus event to all registered targets concurrently.
   *
   * Invariants enforced:
   *  1. Snapshot — the target list is frozen at call time; add/removeTarget
   *     during an in-flight broadcast do not affect that broadcast.
   *  2. Concurrent dispatch — deliver() is called on every target without
   *     awaiting the previous one (same-tick invocation), then Promise.allSettled
   *     collects all outcomes. This guarantees a ≤5 ms start-time spread
   *     between DE_A (loopback) and DE_B (HTTP) on LAN-local transport.
   *  3. No mutation — the same event reference is forwarded unchanged (ADR §C).
   *  4. Isolation — a single target failure yields ok:false for that target;
   *     the broadcast itself never throws.
   *  5. Zero targets — resolves to [] immediately.
   *
   * @returns FanoutResult[] ordered by snapshot position.
   */
  async broadcast(event: StimulusEvent): Promise<FanoutResult[]> {
    // 1. Snapshot: freeze the target list so later mutations are invisible.
    const snapshot = [...this.targets.values()];

    if (snapshot.length === 0) {
      return [];
    }

    // 2. Concurrent dispatch: invoke deliver() on every target WITHOUT awaiting.
    //    Collect the promises, then settle them all in parallel.
    //    Wrap each call in a try/catch so a synchronous throw from deliver() is
    //    normalized to a rejected promise. Promise.allSettled then produces the
    //    correct {ok:false, error} result and per-target isolation (R1) holds.
    const promises = snapshot.map((target) => {
      try {
        return target.deliver(event);
      } catch (err) {
        // A synchronous throw from deliver() is normalized to a rejected
        // promise so per-target isolation (R1) and the no-throw broadcast
        // invariant hold even for misbehaving targets.
        return Promise.reject(err);
      }
    });

    // 3. Settle all promises; individual rejections do not propagate.
    const settled = await Promise.allSettled(promises);

    // 4. Map settled results to FanoutResult[].
    return settled.map((result, idx) => {
      const id = snapshot[idx]!.id;
      if (result.status === 'fulfilled') {
        return { id, ok: true };
      }
      const reason: unknown = result.reason;
      const error = reason instanceof Error ? reason.message : String(reason);
      return { id, ok: false, error };
    });
  }
}
