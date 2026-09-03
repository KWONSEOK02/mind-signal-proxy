import { io, Socket } from 'socket.io-client';
import { config } from '../config';
import type { SampleEnvelope } from '../types/envelope';

/** Milliseconds to wait for a backend ack before treating as transport timeout (retryable). */
const ACK_TIMEOUT_MS = 2000;

/** Milliseconds between drain-loop ticks while connected. */
const DRAIN_INTERVAL_MS = 50;

/**
 * Milliseconds between forwarding summary lines.
 *
 * Why a summary and not a line per sample: on 2026-09-03 subject 1 went STALE on the
 * operator screen for minutes while subject 2 stayed live, and nothing in this file
 * logged anything — success, ack timeout and retryable ack were all silent, so the
 * hop where subject 1 disappeared could not be identified afterwards. One rolled-up
 * line per subject every 10s makes that silence visible while keeping the log small
 * (samples arrive at 1 Hz per subject).
 */
const SUMMARY_INTERVAL_MS = 10_000;

/** Shape of the backend ack payload on event `proxy:sample`. */
interface BeAck {
  ok: boolean;
  duplicate?: boolean;
  error?: string;
  retryable?: boolean;
}

/** Internal queue entry: the envelope plus an in-flight flag to prevent double-send. */
interface QueueEntry {
  envelope: SampleEnvelope;
  inFlight: boolean;
}

/** Per-subject outcome tally for one summary window. Reset after each line. */
interface SubjectCounters {
  forwarded: number;
  ackOk: number;
  ackDuplicate: number;
  ackTimeout: number;
  ackRetryable: number;
  dropped: number;
  evicted: number;
  /** group_id values seen this window — a mismatch here is invisible everywhere else. */
  groupIds: Set<string>;
}

const newCounters = (): SubjectCounters => ({
  forwarded: 0,
  ackOk: 0,
  ackDuplicate: 0,
  ackTimeout: 0,
  ackRetryable: 0,
  dropped: 0,
  evicted: 0,
  groupIds: new Set<string>(),
});

/**
 * BeForwarder — reliable outbound transport for individual SampleEnvelopes to the backend.
 *
 * ADR §C invariant: forward/transport only — NO canonical alignment.
 * The backend `/proxy` namespace handler performs alignment; this class ships each
 * envelope as-is over Socket.io event `proxy:sample`, one per frame.
 *
 * Design:
 *  - Bounded FIFO queue (BE_FORWARD_QUEUE_MAX). Overflow → drop-oldest, admit-incoming.
 *  - Ack contract: {ok:true}|{ok:true,duplicate:true} → delivered;
 *    {ok:false,retryable:true} → re-queue; {ok:false,retryable:false} → drop.
 *  - Transport timeout (no ack within ACK_TIMEOUT_MS) → treated as retryable (keep queued).
 *  - Reconnect replay: un-acked queue entries survive disconnect and are replayed FIFO on reconnect.
 */
export class BeForwarder {
  private socket: Socket | null = null;
  private readonly queue: QueueEntry[] = [];
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  /** subject_idx → counters for the current summary window. */
  private readonly counters = new Map<number, SubjectCounters>();

  /**
   * @param summaryIntervalMs - how often to print the per-subject summary. Only tests
   *   pass this; production uses the 10s default (a shorter one would flood the log).
   */
  constructor(private readonly summaryIntervalMs: number = SUMMARY_INTERVAL_MS) {}

  /** Counters for one subject, created on first sight. */
  private _countersFor(subjectIdx: number): SubjectCounters {
    let c = this.counters.get(subjectIdx);
    if (!c) {
      c = newCounters();
      this.counters.set(subjectIdx, c);
    }
    return c;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Establish a Socket.io connection to the backend `/proxy` namespace.
   * Reads BACKEND_URL and ENGINE_SECRET_KEY from config by default.
   * Optional overrides allow tests to inject ephemeral server URLs/secrets.
   * Resolves once connected; rejects on connect_error (e.g. wrong secret).
   */
  connect(
    backendUrl: string = config.BACKEND_URL,
    engineSecret: string = config.ENGINE_SECRET_KEY,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Connect directly to the /proxy namespace on the backend URL.
      const socket = io(`${backendUrl}/proxy`, {
        transports: ['websocket'],
        auth: { engineSecret },
      });

      let resolved = false;

      socket.once('connect', () => {
        resolved = true;
        this.socket = socket;
        console.log('[BeForwarder] connected to backend /proxy:', backendUrl);
        this._startDrainLoop();
        this._startSummaryLoop();
        resolve();
      });

      socket.once('connect_error', (err: Error) => {
        if (!resolved) {
          console.error('[BeForwarder] initial connect failed:', err.message);
          socket.disconnect();
          reject(err);
        }
      });

      // On disconnect after a successful connect: retain queue for replay.
      socket.on('disconnect', (reason: string) => {
        // The reason separates a backend restart from a network drop, and the queue
        // depth says how much is waiting to be replayed.
        console.warn(`[BeForwarder] disconnected: reason=${reason} queued=${this.queue.length}`);
        // Un-flag all in-flight entries so they are replayed on reconnect.
        for (const entry of this.queue) {
          entry.inFlight = false;
        }
      });

      // On reconnect (socket.io auto-reconnects by default).
      socket.on('connect', () => {
        this.socket = socket;
        console.log(`[BeForwarder] (re)connected, replaying queued=${this.queue.length}`);
        // Un-flag all in-flight entries so they are replayed FIFO.
        for (const entry of this.queue) {
          entry.inFlight = false;
        }
        // Trigger a drain pass immediately after reconnect.
        this._drainOnce();
      });
    });
  }

  /**
   * Enqueue a SampleEnvelope for forwarding to the backend.
   * Never blocks the caller on network.
   * Overflow: evict oldest (drop-oldest), then admit incoming.
   */
  forward(envelope: SampleEnvelope): void {
    // Enforce bounded queue: drop-oldest to make room, then admit incoming.
    if (this.queue.length >= config.BE_FORWARD_QUEUE_MAX) {
      const evicted = this.queue.shift()!;
      const evictionRecord = {
        group_id: evicted.envelope.group_id,
        subject_idx: evicted.envelope.subject_idx,
        seq: evicted.envelope.seq,
        drop_reason: 'forward_queue_overflow',
      };
      console.warn('[BeForwarder] forward_queue_overflow — evicted oldest:', evictionRecord);
      this._countersFor(evicted.envelope.subject_idx).evicted++;
    }

    const counters = this._countersFor(envelope.subject_idx);
    counters.forwarded++;
    counters.groupIds.add(envelope.group_id);
    this.queue.push({ envelope, inFlight: false });
    // Trigger an immediate drain attempt if already connected.
    this._drainOnce();
  }

  /**
   * Cleanly close the socket and stop the drain loop.
   */
  disconnect(): void {
    this._stopDrainLoop();
    this._stopSummaryLoop();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal drain machinery
  // ──────────────────────────────────────────────────────────────────────────

  private _startDrainLoop(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setInterval(() => {
      this._drainOnce();
    }, DRAIN_INTERVAL_MS);
  }

  /**
   * Emit one summary line per subject every SUMMARY_INTERVAL_MS.
   *
   * A subject that has stopped arriving keeps printing `forwarded=0`, which is the
   * signal that was missing on 2026-09-03: silence looks identical to "still fine".
   * A subject with no counters at all is skipped, so an idle proxy stays quiet.
   */
  private _startSummaryLoop(): void {
    if (this.summaryTimer !== null) return;
    this.summaryTimer = setInterval(() => {
      if (this.counters.size === 0) return;
      const connected = this.socket?.connected === true;
      for (const [subjectIdx, c] of [...this.counters.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(
          `[BeForwarder] summary subject=${subjectIdx} forwarded=${c.forwarded} ` +
            `ackOk=${c.ackOk} dup=${c.ackDuplicate} ackTimeout=${c.ackTimeout} ` +
            `retryable=${c.ackRetryable} dropped=${c.dropped} evicted=${c.evicted} ` +
            `queued=${this.queue.length} connected=${connected} ` +
            `groups=[${[...c.groupIds].join(',')}]`,
        );
      }
      // Reset per window so each line describes only the last interval. Keep the keys:
      // a subject that fell to zero must keep printing rather than vanish.
      for (const key of this.counters.keys()) {
        this.counters.set(key, newCounters());
      }
    }, this.summaryIntervalMs);
    // Do not hold the process open just to print summaries.
    this.summaryTimer.unref?.();
  }

  private _stopSummaryLoop(): void {
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  private _stopDrainLoop(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * Attempt to send the next un-in-flight queue entry if the socket is connected.
   *
   * Ack handling (per spec):
   *   {ok:true}                   → dequeue (delivered)
   *   {ok:true, duplicate:true}   → dequeue (idempotent — backend deduped via unique index)
   *   {ok:false, retryable:true}  → release inFlight flag (retry on next tick)
   *   {ok:false, retryable:false} → drop + structured warn
   *   err (transport timeout)     → release inFlight flag (retryable)
   */
  private _drainOnce(): void {
    if (!this.socket?.connected) return;

    for (const entry of this.queue) {
      if (entry.inFlight) continue; // awaiting ack — skip

      entry.inFlight = true;

      this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emit('proxy:sample', entry.envelope, (err: Error | null, ack: BeAck) => {
          const counters = this._countersFor(entry.envelope.subject_idx);

          if (err) {
            // Transport timeout — keep queued, release for retry.
            counters.ackTimeout++;
            entry.inFlight = false;
            return;
          }

          if (ack.ok) {
            // Delivered (includes ok:true,duplicate:true — idempotent success).
            if (ack.duplicate) counters.ackDuplicate++;
            else counters.ackOk++;
            this._dequeue(entry);
          } else if (ack.retryable) {
            // Backend not ready (e.g. aligner_not_ready) — release for retry.
            counters.ackRetryable++;
            entry.inFlight = false;
          } else {
            // Non-retryable failure (invalid_frame / session_not_measuring / fail_closed).
            console.warn('[BeForwarder] non-retryable drop:', {
              error: ack.error,
              group_id: entry.envelope.group_id,
              subject_idx: entry.envelope.subject_idx,
              seq: entry.envelope.seq,
            });
            counters.dropped++;
            this._dequeue(entry);
          }
        });

      // Send only one new entry per drain tick to preserve FIFO ordering.
      break;
    }
  }

  private _dequeue(entry: QueueEntry): void {
    const idx = this.queue.indexOf(entry);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
  }
}
