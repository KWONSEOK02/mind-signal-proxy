import { Router } from 'express';
import type { HealthMonitor } from '../services/health-monitor';

/**
 * 프록시 liveness 주입 seam 라우터 생성함 (T1-PXW-C).
 * route: POST / (mount /heartbeat → POST /heartbeat).
 *
 * R2-2 LOCK 명시: fail-closed canonical 경로는 GET /health 폴링(BE engine-registry
 * + DE check_health, 부모 PLAN L232-235). 본 /heartbeat는 Stage-1에서 POST하는
 * 클라이언트가 없는 liveness 주입 seam임 (DISCUSS Q2 결정). monitor 미주입 시
 * health.ts:13 패턴대로 레거시 200 byte-identical.
 *
 * @param monitor 선택 HealthMonitor — 주입 시 beat() 기록 + isHealthy() 반영
 * @returns Express Router
 */
export function createHeartbeatRouter(monitor?: HealthMonitor): Router {
  const router = Router();
  router.post('/', (_req, res) => {
    if (monitor === undefined) {
      res.status(200).json({ status: 'ok' }); // 레거시 byte-identical
      return;
    }
    monitor.beat();
    const healthy = monitor.isHealthy();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'fail_closed', healthy });
  });
  return router;
}
