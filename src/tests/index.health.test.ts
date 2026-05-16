import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../index';

describe('GET /health', () => {
  it('returns 200 with status ok and non-empty version', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });
});
