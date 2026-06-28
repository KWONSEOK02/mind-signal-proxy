import { io, Socket } from 'socket.io-client';
import { config } from '../config';
import type { SampleEnvelope } from '../types/envelope';

/** Milliseconds to wait for a backend ack before treating as transport timeout (retryable). */
const ACK_TIMEOUT_MS = 2000;

/** Milliseconds between drain-loop ticks while connected. */
const DRAIN_INTERVAL_MS = 50;

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
        this._startDrainLoop();
        resolve();
      });

      socket.once('connect_error', (err: Error) => {
        if (!resolved) {
          socket.disconnect();
          reject(err);
        }
      });

      // On disconnect after a successful connect: retain queue for replay.
      socket.on('disconnect', () => {
        // Un-flag all in-flight entries so they are replayed on reconnect.
        for (const entry of this.queue) {
          entry.inFlight = false;
        }
      });

      // On reconnect (socket.io auto-reconnects by default).
      socket.on('connect', () => {
        this.socket = socket;
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
    }

    this.queue.push({ envelope, inFlight: false });
    // Trigger an immediate drain attempt if already connected.
    this._drainOnce();
  }

  /**
   * Cleanly close the socket and stop the drain loop.
   */
  disconnect(): void {
    this._stopDrainLoop();
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
          if (err) {
            // Transport timeout — keep queued, release for retry.
            entry.inFlight = false;
            return;
          }

          if (ack.ok) {
            // Delivered (includes ok:true,duplicate:true — idempotent success).
            this._dequeue(entry);
          } else if (ack.retryable) {
            // Backend not ready (e.g. aligner_not_ready) — release for retry.
            entry.inFlight = false;
          } else {
            // Non-retryable failure (invalid_frame / session_not_measuring / fail_closed).
            console.warn('[BeForwarder] non-retryable drop:', {
              error: ack.error,
              group_id: entry.envelope.group_id,
              subject_idx: entry.envelope.subject_idx,
              seq: entry.envelope.seq,
            });
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
