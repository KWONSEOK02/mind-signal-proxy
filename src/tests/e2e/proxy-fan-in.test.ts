import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'http';
import { Server as SocketIoServer, type Socket as ServerSocket } from 'socket.io';
import type { AddressInfo } from 'net';
import { SampleEnvelopeSchema } from '../../types/envelope';

const E2E_SECRET = 'e2e-engine-secret';
process.env.ENGINE_SECRET_KEY = E2E_SECRET; // BEFORE dynamic import of app

// dynamically-loaded app-under-test
let createApp: (typeof import('../../index'))['createApp'];
let connectBeForwarderWithRetry: (typeof import('../../index'))['connectBeForwarderWithRetry'];
let PairBuffer: (typeof import('../../services/pair-buffer'))['PairBuffer'];
let BeForwarder: (typeof import('../../services/be-forwarder'))['BeForwarder'];

beforeAll(async () => {
  ({ createApp, connectBeForwarderWithRetry } = await import('../../index'));
  ({ PairBuffer } = await import('../../services/pair-buffer'));
  ({ BeForwarder } = await import('../../services/be-forwarder'));
});

let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (shutdown) {
    await shutdown();
    shutdown = undefined;
  }
});

// INLINE CLONE of be-forwarder.test.ts:36 setupMockBe, CX2-2 signature (port param, listen(port))
function setupMockBe(
  port: number,
  secret: string,
  onSample: (socket: ServerSocket, envelope: unknown, ackFn: (ack: unknown) => void) => void,
): Promise<void> {
  const httpServer: Server = createServer();
  const ioServer = new SocketIoServer(httpServer);
  const proxy = ioServer.of('/proxy');
  proxy.use((socket, next) => {
    const { engineSecret } = socket.handshake.auth as { engineSecret?: string };
    if (engineSecret !== secret) next(new Error('unauthorized'));
    else next();
  });
  proxy.on('connection', (socket) => {
    socket.on('proxy:sample', (envelope: unknown, ackFn: (ack: unknown) => void) =>
      onSample(socket, envelope, ackFn),
    );
  });
  shutdown = () => new Promise<void>((r) => ioServer.close(() => httpServer.close(() => r())));
  return new Promise((resolve) => httpServer.listen(port, () => resolve()));
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const deBody = {
  group_id: 'g1',
  subject_idx: 0,
  de_ts_ns: '1700000000000000000',
  seq: 1,
  payload: { delta: 0.1, theta: 0.2, alpha: 0.3, beta: 0.4, gamma: 0.5 },
  sync_meta: {},
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('proxy fan-in e2e (DE→Proxy→mock BE)', () => {
  it('happy: POST /ingest/sample → BeForwarder → mock BE receives 1 envelope w/ epoch proxy_ingress_ts_ns + acks', async () => {
    const port = await freePort();
    let received: unknown;
    let count = 0;
    await setupMockBe(port, E2E_SECRET, (_s, env, ack) => {
      received = env;
      count += 1;
      ack({ ok: true });
    });
    const beForwarder = new BeForwarder();
    await beForwarder.connect(`http://localhost:${port}`, E2E_SECRET);
    const app = createApp(undefined, undefined, { pairBuffer: new PairBuffer(), beForwarder });
    const res = await request(app)
      .post('/ingest/sample')
      .set('x-engine-secret', E2E_SECRET)
      .send(deBody);
    expect(res.status).toBe(200);
    await delay(500);
    expect(count).toBe(1);
    const parsed = SampleEnvelopeSchema.safeParse(received);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(/^\d{1,21}$/.test(parsed.data.proxy_ingress_ts_ns)).toBe(true);
      const diff = BigInt(parsed.data.proxy_ingress_ts_ns) - BigInt(Date.now()) * 1_000_000n;
      expect(diff > -5_000_000_000n && diff < 5_000_000_000n).toBe(true); // epoch domain
    }
    beForwarder.disconnect();
  });

  it('CX-2 down-then-up: POST while BE down (queued) → BE starts → retry connect drains queue → mock BE receives', async () => {
    const port = await freePort();
    const beForwarder = new BeForwarder();
    const timers: Array<{ cb: () => void; ms: number }> = [];
    // BE NOT started yet → connect rejects → retry scheduled via injected setTimer
    connectBeForwarderWithRetry(
      { connect: () => beForwarder.connect(`http://localhost:${port}`, E2E_SECRET) },
      {
        setTimer: (cb, ms) => {
          timers.push({ cb, ms });
        },
      },
    );
    await vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(1));
    const app = createApp(undefined, undefined, { pairBuffer: new PairBuffer(), beForwarder });
    const res = await request(app)
      .post('/ingest/sample')
      .set('x-engine-secret', E2E_SECRET)
      .send(deBody);
    expect(res.status).toBe(200); // queued in BeForwarder (not yet connected)
    let count = 0;
    await setupMockBe(port, E2E_SECRET, (_s, _e, ack) => {
      count += 1;
      ack({ ok: true });
    });
    timers[0].cb(); // fire retry → connect resolves → drain
    await vi.waitFor(() => expect(count).toBe(1), { timeout: 3000 });
    expect(count).toBe(1);
    beForwarder.disconnect();
  });
});
