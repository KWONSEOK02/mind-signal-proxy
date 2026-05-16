import express from 'express';
import { config } from './config';
import { createHealthRouter } from './routes/health';
import { createRegisterRouter } from './routes/register';
import heartbeatRouter from './routes/heartbeat';
import ingestRouter from './routes/ingest';
import { createControlAssignGroupRouter } from './routes/control-assign-group';
import { HealthMonitor } from './services/health-monitor';
import { PendingRegistry } from './services/pending-registry';

/**
 * Create the Express application.
 *
 * @param monitor          Optional HealthMonitor.  When provided, GET /health reflects its
 *                         health state (200 ok / 503 fail_closed).  When omitted, GET /health
 *                         always returns 200 { status: 'ok', version } — byte-identical to
 *                         the legacy no-monitor behavior (backward-compat regression guard).
 * @param pendingRegistry  Optional PendingRegistry.  When omitted, a fresh instance is
 *                         created internally.  Both parameters are positional and optional
 *                         so existing callers passing only a monitor continue to work.
 *
 * NOTE: `createApp` does NOT start any timer.  The caller (entrypoint only) is
 * responsible for monitor.start() before passing the monitor in.  PendingRegistry
 * only sets timers when register() is called — createApp itself never calls register(),
 * so tests using createApp() with no prior register() calls will have zero leaked timers.
 */
export function createApp(
  monitor?: HealthMonitor,
  pendingRegistry?: PendingRegistry,
): express.Application {
  const app = express();
  const registry = pendingRegistry ?? new PendingRegistry();

  app.use(express.json());

  app.use('/health', createHealthRouter(monitor));
  app.use('/register', createRegisterRouter(registry));
  app.use('/heartbeat', heartbeatRouter);
  app.use('/ingest', ingestRouter);
  app.use('/control/assign-group', createControlAssignGroupRouter(registry));

  return app;
}

if (require.main === module) {
  // Entrypoint only: construct and start the health monitor, then wire it into the app.
  // Tests never reach this path, so no leaked intervals in test runs.
  const monitor = new HealthMonitor();
  monitor.start();

  const app = createApp(monitor, new PendingRegistry());
  app.listen(config.PROXY_PORT, () => {
    console.log(`mind-signal-proxy listening on port ${config.PROXY_PORT}`);
  });
}
