import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createIngestRouter } from '../routes/ingest';
import { PushOutcome } from '../services/pair-buffer';
import type { SampleEnvelope } from '../types/envelope';

const TEST_SECRET = 'test-secret';
const FIXED_CLOCK_VALUE = '1700000000001000000';

/** Valid DE body (NO proxy_ingress_ts_ns — proxy adds it) */
const validDeBody = {
  group_id: 'g1',
  subject_idx: 0,
  de_ts_ns: '1700000000000000000',
  seq: 1,
  payload: { delta: 0.1, theta: 0.2, alpha: 0.3, beta: 0.4, gamma: 0.5 },
  sync_meta: {},
};

function makeApp(engineSecret: string = TEST_SECRET, pushOutcome: PushOutcome = PushOutcome.Gap) {
  const pairBuffer = { push: vi.fn(() => pushOutcome) };
  const beForwarder = { forward: vi.fn() };
  const ingressClock = () => FIXED_CLOCK_VALUE;

  const router = createIngestRouter({ pairBuffer, beForwarder, ingressClock, engineSecret });

  const app = express();
  app.use(express.json());
  app.use('/', router);

  return { app, pairBuffer, beForwarder };
}

describe('[TS-PROXY-01] POST /sample — ingest router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TC-1: valid body + correct x-engine-secret → 200 {ok:true}, forward called once with proxy_ingress_ts_ns, push called once', async () => {
    const { app, pairBuffer, beForwarder } = makeApp();

    const res = await request(app)
      .post('/sample')
      .set('x-engine-secret', TEST_SECRET)
      .send(validDeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(beForwarder.forward).toHaveBeenCalledTimes(1);
    const forwardedEnvelope = (beForwarder.forward as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as SampleEnvelope;
    expect(forwardedEnvelope.proxy_ingress_ts_ns).toBe(FIXED_CLOCK_VALUE);

    expect(pairBuffer.push).toHaveBeenCalledTimes(1);
  });

  it('TC-2: missing x-engine-secret header → 401 {error:"unauthorized"}', async () => {
    const { app, beForwarder } = makeApp();

    const res = await request(app).post('/sample').send(validDeBody);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(beForwarder.forward).not.toHaveBeenCalled();
  });

  it('TC-3: empty configured secret (engineSecret="") even with matching empty header → 401', async () => {
    const { app, beForwarder } = makeApp('');

    const res = await request(app).post('/sample').set('x-engine-secret', '').send(validDeBody);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(beForwarder.forward).not.toHaveBeenCalled();
  });

  it('TC-4: wrong x-engine-secret → 401', async () => {
    const { app, beForwarder } = makeApp();

    const res = await request(app)
      .post('/sample')
      .set('x-engine-secret', 'WRONG-SECRET')
      .send(validDeBody);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(beForwarder.forward).not.toHaveBeenCalled();
  });

  it('TC-5: body missing group_id (otherwise valid) → 400 {error:"bad_request"}, forward NOT called', async () => {
    const { app, beForwarder } = makeApp();

    const bodyWithoutGroupId = { ...validDeBody, group_id: undefined };

    const res = await request(app)
      .post('/sample')
      .set('x-engine-secret', TEST_SECRET)
      .send(bodyWithoutGroupId);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(beForwarder.forward).not.toHaveBeenCalled();
  });

  it('TC-6: pairBuffer.push returns PushOutcome.Dropped → beForwarder.forward still called once, response 200', async () => {
    const { app, beForwarder } = makeApp(TEST_SECRET, PushOutcome.Dropped);

    const res = await request(app)
      .post('/sample')
      .set('x-engine-secret', TEST_SECRET)
      .send(validDeBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(beForwarder.forward).toHaveBeenCalledTimes(1);
  });
});
