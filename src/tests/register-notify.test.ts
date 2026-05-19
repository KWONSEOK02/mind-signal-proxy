import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PendingRegistry } from '../services/pending-registry';
import { createRegisterRouter } from '../routes/register';
import type { BeNotifierPort } from '../services/be-notifier';

const TEST_SECRET = 'test-engine-secret-xyz';

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup
// ─────────────────────────────────────────────────────────────────────────────

let registry: PendingRegistry;
let beNotifier: {
  notifyRegister: ReturnType<typeof vi.fn>;
  notifyUnregister: ReturnType<typeof vi.fn>;
} & BeNotifierPort;
let app: ReturnType<typeof express>;

beforeEach(() => {
  // Long TTL so entries never expire during tests
  registry = new PendingRegistry(999_999_999);
  beNotifier = {
    notifyRegister: vi.fn(),
    notifyUnregister: vi.fn(),
  };
  app = express();
  app.use(express.json());
  app.use('/', createRegisterRouter(registry, { engineSecret: TEST_SECRET, beNotifier }));
});

afterEach(() => {
  registry.clearAll();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('createRegisterRouter with BeNotifier', () => {
  // ───────────────────────── valid → notifyRegister 1회 ─────────────────────────
  it('valid → notifyRegister 1회', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(registry.resolve(1)).toBe('http://de-a:8000');
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(1);
    expect(beNotifier.notifyRegister).toHaveBeenCalledWith({
      subjectIndex: 1,
      engineUrl: 'http://de-a:8000',
    });
  });

  // ───────────────────────── missing secret ─────────────────────────
  it('secret 헤더 없음 → 401, notifyRegister 0회, registry 미등록', async () => {
    const res = await request(app).post('/').send({ subject_idx: 1, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
    expect(registry.resolve(1)).toBeUndefined();
  });

  // ───────────────────────── wrong secret ─────────────────────────
  it('secret 헤더 틀림 → 401, notifyRegister 0회, registry 미등록', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', 'wrong-secret')
      .send({ subject_idx: 1, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
    expect(registry.resolve(1)).toBeUndefined();
  });

  // ───────────────────────── empty engineSecret fail-closed ─────────────────────────
  it('engineSecret 빈값 → 401 fail-closed, notifyRegister 0회', async () => {
    // Build a separate app with empty engineSecret
    const emptyApp = express();
    emptyApp.use(express.json());
    emptyApp.use('/', createRegisterRouter(registry, { engineSecret: '', beNotifier }));

    const res = await request(emptyApp)
      .post('/')
      .set('x-engine-secret', '')
      .send({ subject_idx: 1, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(401);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
  });

  // ───────────────────────── non-URL de_url ─────────────────────────
  it("비-URL de_url('not a url') → 400, notifyRegister 0회", async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 1, de_url: 'not a url' });

    expect(res.status).toBe(400);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
  });

  // ───────────────────────── subject_idx=0 → 400 ─────────────────────────
  it('subject_idx=0 → 400, notifyRegister 0회', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 0, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(400);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
  });

  // ───────────────────────── subject_idx=3 → 400 ─────────────────────────
  it('subject_idx=3 → 400, notifyRegister 0회', async () => {
    const res = await request(app)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 3, de_url: 'http://de-a:8000' });

    expect(res.status).toBe(400);
    expect(beNotifier.notifyRegister).toHaveBeenCalledTimes(0);
  });

  // ───────────────────────── CX-3: sync throw swallowed ─────────────────────────
  it('CX-3: notifyRegister sync throw 무시, 라우트 200, registry 등록', async () => {
    const throwingNotifier: BeNotifierPort = {
      notifyRegister: vi.fn(() => {
        throw new Error('sync boom');
      }),
      notifyUnregister: vi.fn(),
    };

    const cxApp = express();
    cxApp.use(express.json());
    cxApp.use(
      '/',
      createRegisterRouter(registry, { engineSecret: TEST_SECRET, beNotifier: throwingNotifier }),
    );

    const res = await request(cxApp)
      .post('/')
      .set('x-engine-secret', TEST_SECRET)
      .send({ subject_idx: 2, de_url: 'http://de-b:8001' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Registry still populated despite throw
    expect(registry.resolve(2)).toBe('http://de-b:8001');
  });
});
