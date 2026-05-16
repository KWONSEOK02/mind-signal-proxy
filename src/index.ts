import express from 'express';
import { config } from './config';
import { createHealthRouter } from './routes/health';
import registerRouter from './routes/register';
import heartbeatRouter from './routes/heartbeat';
import ingestRouter from './routes/ingest';
import controlAssignGroupRouter from './routes/control-assign-group';
import { HealthMonitor } from './services/health-monitor';

/**
 * Create the Express application.
 *
 * @param monitor  Optional HealthMonitor.  When provided, GET /health reflects its
 *                 health state (200 ok / 503 fail_closed).  When omitted, GET /health
 *                 always returns 200 { status: 'ok', version } — byte-identical to
 *                 the legacy no-monitor behavior (backward-compat regression guard).
 *
 * NOTE: `createApp` does NOT start any timer.  The caller (entrypoint only) is
 * responsible for monitor.start() before passing the monitor in.  This prevents
 * leaked intervals in tests.
 */
export function createApp(monitor?: HealthMonitor): express.Application {
  const app = express();

  app.use(express.json());

  app.use('/health', createHealthRouter(monitor));
  app.use('/register', registerRouter);
  app.use('/heartbeat', heartbeatRouter);
  app.use('/ingest', ingestRouter);
  app.use('/control/assign-group', controlAssignGroupRouter);

  return app;
}

if (require.main === module) {
  // Entrypoint only: construct and start the health monitor, then wire it into the app.
  // Tests never reach this path, so no leaked intervals in test runs.
  const monitor = new HealthMonitor();
  monitor.start();

  const app = createApp(monitor);
  app.listen(config.PROXY_PORT, () => {
    console.log(`mind-signal-proxy listening on port ${config.PROXY_PORT}`);
  });
}
