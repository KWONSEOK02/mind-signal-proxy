import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { Server as SocketIoServer, type Socket as ServerSocket } from 'socket.io';
import { AddressInfo } from 'net';
import { BeForwarder } from '../services/be-forwarder';
import { SampleEnvelopeSchema } from '../types/envelope';
import type { SampleEnvelope } from '../types/envelope';

const TEST_SECRET = 'test-secret-abc';

/** Build a minimal valid SampleEnvelope. */
function makeEnvelope(seq = 1, groupId = 'g1', subjectIdx = 0): SampleEnvelope {
  return {
    group_id: groupId,
    subject_idx: subjectIdx,
    de_ts_ns: '1700000000000000000',
    proxy_ingress_ts_ns: '1700000000001000000',
    seq,
    payload: { delta: 0.1, theta: 0.2, alpha: 0.3, beta: 0.4, gamma: 0.5 },
    sync_meta: {},
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────

describe('BeForwarder — integration (mock backend)', () => {
  let forwarder: BeForwarder;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: SocketIoServer;
  let serverUrl: string;
  let shutdown: () => Promise<void>;

  /** Spin up a mock BE server with a given onSample handler and secret. */
  function setupMockBe(
    secret: string,
    onSample: (socket: ServerSocket, envelope: unknown, ackFn: (ack: unknown) => void) => void,
  ): Promise<void> {
    httpServer = createServer();
    ioServer = new SocketIoServer(httpServer);

    const proxy = ioServer.of('/proxy');
    proxy.use((socket, next) => {
      const { engineSecret } = socket.handshake.auth as { engineSecret?: string };
      if (engineSecret !== secret) {
        next(new Error('unauthorized'));
      } else {
        next();
      }
    });

    proxy.on('connection', (socket) => {
      socket.on('proxy:sample', (envelope: unknown, ackFn: (ack: unknown) => void) => {
        onSample(socket, envelope, ackFn);
      });
    });

    shutdown = () =>
      new Promise((resolve) => {
        ioServer.close(() => httpServer.close(() => resolve()));
      });

    return new Promise((resolve) => {
      httpServer.listen(0, () => {
        const port = (httpServer.address() as AddressInfo).port;
        serverUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }

  beforeEach(() => {
    forwarder = new BeForwarder();
  });

  afterEach(async () => {
    forwarder.disconnect();
    if (shutdown) await shutdown();
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('forwarded frame is received by mock BE and parses via SampleEnvelopeSchema (shape intact, unmutated)', async () => {
    const originalEnvelope = makeEnvelope(1, 'grp-schema', 0);
    let receivedRaw: unknown;

    await setupMockBe(TEST_SECRET, (_socket, envelope, ackFn) => {
      receivedRaw = envelope;
      ackFn({ ok: true });
    });

    await forwarder.connect(serverUrl, TEST_SECRET);
    forwarder.forward(originalEnvelope);

    await delay(500);

    expect(receivedRaw).toBeDefined();
    const parsed = SampleEnvelopeSchema.safeParse(receivedRaw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Shape must be unmutated — every field matches original.
      expect(parsed.data.group_id).toBe(originalEnvelope.group_id);
      expect(parsed.data.subject_idx).toBe(originalEnvelope.subject_idx);
      expect(parsed.data.seq).toBe(originalEnvelope.seq);
      expect(parsed.data.de_ts_ns).toBe(originalEnvelope.de_ts_ns);
      expect(parsed.data.proxy_ingress_ts_ns).toBe(originalEnvelope.proxy_ingress_ts_ns);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('mock BE acks {ok:true} → forwarder dequeues (queue empties)', async () => {
    await setupMockBe(TEST_SECRET, (_socket, _envelope, ackFn) => {
      ackFn({ ok: true });
    });

    await forwarder.connect(serverUrl, TEST_SECRET);
    forwarder.forward(makeEnvelope(1));

    await delay(500);

    expect(forwarder.queueDepth()).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('mock BE acks {ok:false, error:"session_not_measuring", retryable:false} → envelope dropped, NOT retried', async () => {
    const receivedSeqs: number[] = [];

    await setupMockBe(TEST_SECRET, (_socket, envelope, ackFn) => {
      receivedSeqs.push((envelope as SampleEnvelope).seq);
      ackFn({ ok: false, error: 'session_not_measuring', retryable: false });
    });

    await forwarder.connect(serverUrl, TEST_SECRET);
    forwarder.forward(makeEnvelope(42));

    // Wait enough time for a retry to appear if incorrectly retried.
    await delay(600);

    // Dropped: queue is empty.
    expect(forwarder.queueDepth()).toBe(0);
    // Received exactly once — NOT retried.
    expect(receivedSeqs.filter((s) => s === 42)).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('mock BE acks {ok:false, error:"aligner_not_ready", retryable:true} → envelope retried (resent)', async () => {
    let receiveCount = 0;

    await setupMockBe(TEST_SECRET, (_socket, _envelope, ackFn) => {
      receiveCount += 1;
      if (receiveCount === 1) {
        // First delivery: retryable failure.
        ackFn({ ok: false, error: 'aligner_not_ready', retryable: true });
      } else {
        // Subsequent retries: succeed.
        ackFn({ ok: true });
      }
    });

    await forwarder.connect(serverUrl, TEST_SECRET);
    forwarder.forward(makeEnvelope(7));

    // Wait long enough for retry + success.
    await delay(600);

    // Retried: received more than once.
    expect(receiveCount).toBeGreaterThanOrEqual(2);
    // Eventually delivered: queue is empty.
    expect(forwarder.queueDepth()).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('mock BE never acks (socket.timeout fires) → envelope kept queued and resent after timeout', async () => {
    // Mock BE receives events but NEVER calls ackFn — forces ACK_TIMEOUT_MS to expire.
    let receiveCount = 0;

    await setupMockBe(TEST_SECRET, (_socket, _envelope, _ackFn) => {
      receiveCount += 1;
      // Intentionally never call _ackFn.
    });

    await forwarder.connect(serverUrl, TEST_SECRET);
    forwarder.forward(makeEnvelope(99));

    // Wait for ACK_TIMEOUT_MS (2000ms) + one retry window.
    await delay(2800);

    // Queue must NOT be empty — envelope was not dropped.
    expect(forwarder.queueDepth()).toBeGreaterThan(0);
    // Must have been sent at least twice (initial send + at least one retry after timeout).
    expect(receiveCount).toBeGreaterThanOrEqual(2);
  });

  // ──────────────────────────────────────────────────────────────────────────

  it('handshake: wrong engineSecret → connect() rejects gracefully (no crash)', async () => {
    await setupMockBe(TEST_SECRET, (_socket, _envelope, ackFn) => {
      ackFn({ ok: true });
    });

    const wrongForwarder = new BeForwarder();
    let caughtError: unknown;
    try {
      await wrongForwarder.connect(serverUrl, 'WRONG-SECRET');
    } catch (err) {
      caughtError = err;
    } finally {
      wrongForwarder.disconnect();
    }
    // connect_error must have been thrown (wrong secret → unauthorized).
    expect(caughtError).toBeDefined();
  });

  it('handshake: correct engineSecret → connect() resolves', async () => {
    await setupMockBe(TEST_SECRET, (_socket, _envelope, ackFn) => {
      ackFn({ ok: true });
    });

    const goodForwarder = new BeForwarder();
    await expect(goodForwarder.connect(serverUrl, TEST_SECRET)).resolves.toBeUndefined();
    goodForwarder.disconnect();
  });
});
