import { Router } from 'express';
import { version } from '../../package.json';
import type { HealthMonitor } from '../services/health-monitor';

/**
 * Create an Express Router for the `/health` endpoint.
 *
 * @param monitor  Optional HealthMonitor instance.
 *   - undefined  → always 200 { status: 'ok', version }   (legacy backward-compatible behavior)
 *   - monitor.isHealthy() true  → 200 { status: 'ok', version }
 *   - monitor.isHealthy() false → 503 { status: 'fail_closed', version }
 */
export function createHealthRouter(monitor?: HealthMonitor): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    if (monitor === undefined || monitor.isHealthy()) {
      res.status(200).json({ status: 'ok', version });
    } else {
      res.status(503).json({ status: 'fail_closed', version });
    }
  });

  return router;
}
