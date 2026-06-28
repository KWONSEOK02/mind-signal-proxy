/** Classification result for a tracked sequence number. */
export enum SeqClassification {
  InOrder = 'in-order',
  OutOfOrder = 'out-of-order',
  Gap = 'gap',
}

/**
 * Per-engine (per subject_idx) sequence number tracker.
 * Detects out-of-order delivery and gaps; emits WARN logs on anomalies.
 * Does NOT throw — all anomalies are classified and logged.
 */
export class SeqTracker {
  /** Last successfully seen seq per subject_idx. undefined = never seen. */
  private readonly lastSeen: Map<number, number> = new Map();

  /**
   * Record an incoming seq for the given subject_idx.
   * @returns classification of this seq relative to the last seen.
   */
  track(subjectIdx: number, seq: number): SeqClassification {
    const last = this.lastSeen.get(subjectIdx);

    if (last === undefined) {
      // First sample from this subject — always in-order.
      this.lastSeen.set(subjectIdx, seq);
      return SeqClassification.InOrder;
    }

    if (seq <= last) {
      // Out-of-order: duplicate or backward step.
      console.warn(
        `[SeqTracker] out-of-order subject_idx=${subjectIdx} expected=${last + 1} got=${seq}`,
      );
      return SeqClassification.OutOfOrder;
    }

    if (seq > last + 1) {
      // Gap: one or more seq numbers skipped.
      console.warn(`[SeqTracker] gap subject_idx=${subjectIdx} expected=${last + 1} got=${seq}`);
      this.lastSeen.set(subjectIdx, seq);
      return SeqClassification.Gap;
    }

    // Exactly last+1 — in-order.
    this.lastSeen.set(subjectIdx, seq);
    return SeqClassification.InOrder;
  }
}
