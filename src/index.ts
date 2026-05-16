import express from 'express';
import { config } from './config';
import healthRouter from './routes/health';
import registerRouter from './routes/register';
import heartbeatRouter from './routes/heartbeat';
import ingestRouter from './routes/ingest';
import controlAssignGroupRouter from './routes/control-assign-group';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/register', registerRouter);
  app.use('/heartbeat', heartbeatRouter);
  app.use('/ingest', ingestRouter);
  app.use('/control/assign-group', controlAssignGroupRouter);

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.PROXY_PORT, () => {
    console.log(`mind-signal-proxy listening on port ${config.PROXY_PORT}`);
  });
}
