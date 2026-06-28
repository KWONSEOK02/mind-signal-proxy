import { config } from '../config';
import type { SampleEnvelope } from '../types/envelope';
import { SeqTracker } from './seq-tracker';

/** Outcome returned by PairBuffer.push(). */
export enum PushOutcome {
  Matched = 'matched',
  Gap = 'gap',
  Dropped = 'dropped',
}

/** CX-3 metadata written to sync_meta on a buffer_overflow drop. */
export interface DropMeta {
  dropped_seq_ranges: Array<{ from: number; to: number }>;
  drop_reason: 'buffer_overflow';
  queue_depth: number;
}

/**
 * Per-engine bounded forwarding buffer with paired-window grouping.
 *
 * ADR §C invariant: this class ONLY buffers/reorders/groups for forwarding.
 * It does NOT produce canonical aligned pairs — that authority belongs to the
 * backend aligner in a different repo.
 *
 * Window semantics: two envelopes (one per subject_idx) are considered a pair
 * when |proxy_ingress_ts_ns_A − proxy_ingress_ts_ns_B| <= PAIRED_WINDOW_MS * 1e6 ns.
 * BigInt arithmetic is used throughout — Number() conversion on >2^53 ns values
 * is prohibited.
 */
export class PairBuffer {
  private readonly maxPerSubject: number;
  private readonly windowNs: bigint;

  /** Per-subject FIFO queues of buffered envelopes. */
  private readonly queues: Map<number, SampleEnvelope[]> = new Map();

  /** Per-engine seq trackers. */
  private readonly seqTracker: SeqTracker = new SeqTracker();

  constructor(maxPerSubject = config.PAIR_BUFFER_SIZE, pairedWindowMs = config.PAIRED_WINDOW_MS) {
    this.maxPerSubject = maxPerSubject;
    // Convert ms to ns using BigInt to avoid floating-point imprecision.
    this.windowNs = BigInt(pairedWindowMs) * BigInt(1_000_000);
  }

  /**
   * Push an envelope into the buffer.
   * @returns 'matched' | 'gap' | 'dropped'
   */
  push(envelope: SampleEnvelope): PushOutcome {
    const { subject_idx, seq } = envelope;

    // Track seq for this subject (emits WARN on anomaly; does not throw).
    this.seqTracker.track(subject_idx, seq);

    // Ensure a queue exists for this subject.
    if (!this.queues.has(subject_idx)) {
      this.queues.set(subject_idx, []);
    }
    const myQueue = this.queues.get(subject_idx)!;

    // Enforce PAIR_BUFFER_SIZE: evict oldest to make room, then admit incoming.
    if (myQueue.length >= this.maxPerSubject) {
      const evicted = myQueue.shift()!;
      const dropMeta: DropMeta = {
        dropped_seq_ranges: [{ from: evicted.seq, to: evicted.seq }],
        drop_reason: 'buffer_overflow',
        queue_depth: myQueue.length,
      };
      // Annotate the evicted envelope's sync_meta for inspection.
      evicted.sync_meta = { ...evicted.sync_meta, ...dropMeta };
      // Admit the incoming envelope after making room, then signal drop occurred.
      myQueue.push(envelope);
      return PushOutcome.Dropped;
    }

    // Enqueue the new envelope (normal path — buffer not full).
    myQueue.push(envelope);

    // Attempt window-based pairing against every other subject's queue.
    const envelopeNs = BigInt(envelope.proxy_ingress_ts_ns);
    let matched = false;

    for (const [otherSubject, otherQueue] of this.queues.entries()) {
      if (otherSubject === subject_idx) continue;

      // Find the first candidate in the other queue within the window.
      const candidateIdx = otherQueue.findIndex((other) => {
        const otherNs = BigInt(other.proxy_ingress_ts_ns);
        const diff = envelopeNs >= otherNs ? envelopeNs - otherNs : otherNs - envelopeNs;
        return diff <= this.windowNs;
      });

      if (candidateIdx !== -1) {
        // Pair formed — dequeue both envelopes (keeps queues bounded). The paired
        // result is not consumed in production, so it is not stored (prevents
        // unbounded matchedPairs growth — leak fix).
        otherQueue.splice(candidateIdx, 1);
        myQueue.splice(myQueue.indexOf(envelope), 1);
        matched = true;
        break; // Only form one pair per push.
      }
    }

    return matched ? PushOutcome.Matched : PushOutcome.Gap;
  }
}
