// === 기존 import 유지 — 삭제 금지 (index.ts:1-9 실측, R-1 Critical) ===
import express from 'express';
import { config } from './config';
import { createHealthRouter } from './routes/health';
import { createRegisterRouter } from './routes/register';
import { createControlAssignGroupRouter } from './routes/control-assign-group';
import { HealthMonitor } from './services/health-monitor'; // 기존 index.ts:8 — 유지
import { PendingRegistry } from './services/pending-registry'; // 기존 index.ts:9 — 유지
// === 변경: default → named factory (index.ts:5,6 치환) ===
import { createHeartbeatRouter } from './routes/heartbeat';
import { createIngestRouter } from './routes/ingest';
import type { PairBufferPort, BeForwarderPort } from './routes/ingest'; // CX2-1
// === 신규 service import ===
import { PairBuffer } from './services/pair-buffer';
import { BeForwarder } from './services/be-forwarder';

// CX2-1: app-DI 경계도 port 타입 — 실 PairBuffer/BeForwarder 인스턴스는 구조적
// 호환(push/forward 보유)이라 그대로 할당 가능, vi mock도 typecheck:test 통과
export interface IngestDeps {
  pairBuffer: PairBufferPort;
  beForwarder: BeForwarderPort;
}

export function createApp(
  monitor?: HealthMonitor,
  pendingRegistry?: PendingRegistry,
  ingestDeps?: IngestDeps, // 신규 positional optional
): express.Application {
  const app = express();
  const registry = pendingRegistry ?? new PendingRegistry();
  // 생략 시 fresh 생성 — connect 안 함(createApp no-socket 계약 보존, 무인자 부작용 0)
  const pairBuffer = ingestDeps?.pairBuffer ?? new PairBuffer();
  const beForwarder = ingestDeps?.beForwarder ?? new BeForwarder();

  app.use(express.json());
  app.use('/health', createHealthRouter(monitor));
  app.use('/register', createRegisterRouter(registry));
  app.use('/heartbeat', createHeartbeatRouter(monitor)); // factory
  app.use('/ingest', createIngestRouter({ pairBuffer, beForwarder })); // → /ingest/sample
  app.use('/control/assign-group', createControlAssignGroupRouter(registry));
  return app;
}

/**
 * 초기 connect 실패 시 socket.io 자동 reconnect가 사멸하므로(be-forwarder.ts:79-83)
 * 엔트리포인트 레벨 지수 backoff 재시도함 (CX-2). export → 단위 테스트 가능.
 * @param bf BeForwarder 인스턴스
 * @param deps 주입형 connect/timer (테스트 결정론) — 기본 실 구현
 */
export function connectBeForwarderWithRetry(
  bf: { connect: () => Promise<void> },
  deps: { setTimer?: (cb: () => void, ms: number) => void; maxBackoffMs?: number } = {},
  attempt = 0,
): void {
  const setTimer =
    deps.setTimer ??
    ((cb, ms) => {
      setTimeout(cb, ms).unref?.();
    });
  const maxBackoffMs = deps.maxBackoffMs ?? 30_000;
  bf.connect().catch((err) => {
    const backoffMs = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
    console.error(
      `[proxy] BE connect 실패 (시도 ${attempt + 1}), ${backoffMs}ms 후 재시도함:`,
      err,
    );
    setTimer(() => connectBeForwarderWithRetry(bf, deps, attempt + 1), backoffMs);
  });
}

if (require.main === module) {
  const monitor = new HealthMonitor();
  monitor.start();
  const pairBuffer = new PairBuffer();
  const beForwarder = new BeForwarder();
  connectBeForwarderWithRetry(beForwarder); // 단발 .catch() 아님 (CX-2)
  const app = createApp(monitor, new PendingRegistry(), { pairBuffer, beForwarder });
  app.listen(config.PROXY_PORT, () => {
    console.log(`mind-signal-proxy listening on port ${config.PROXY_PORT}`);
  });
}
