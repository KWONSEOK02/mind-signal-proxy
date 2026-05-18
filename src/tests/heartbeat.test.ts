import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { HealthMonitor } from '../services/health-monitor';
import { createHeartbeatRouter } from '../routes/heartbeat';

function buildApp(monitor?: HealthMonitor) {
  const app = express();
  app.use(express.json());
  app.use('/heartbeat', createHeartbeatRouter(monitor));
  return app;
}

describe('POST /heartbeat', () => {
  it('returns 200 and healthy:true when monitor.isHealthy() is true', async () => {
    const monitor = new HealthMonitor(1000, 3000);
    const beatSpy = vi.spyOn(monitor, 'beat');
    vi.spyOn(monitor, 'isHealthy').mockReturnValue(true);

    const res = await request(buildApp(monitor)).post('/heartbeat');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', healthy: true });
    expect(beatSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 503 and healthy:false when monitor.isHealthy() is false', async () => {
    const monitor = new HealthMonitor(1000, 3000);
    const beatSpy = vi.spyOn(monitor, 'beat');
    vi.spyOn(monitor, 'isHealthy').mockReturnValue(false);

    const res = await request(buildApp(monitor)).post('/heartbeat');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'fail_closed', healthy: false });
    expect(beatSpy).toHaveBeenCalledTimes(1);
  });

  it('returns legacy 200 with status:ok and no healthy field when monitor is undefined', async () => {
    const res = await request(buildApp(undefined)).post('/heartbeat');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.body).not.toHaveProperty('healthy');
  });
});
