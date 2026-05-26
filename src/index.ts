// dotenv 로드는 config.ts import 전에 1회 — config.ts가 모듈 로드 시점 process.env를 읽으므로 필수
import 'dotenv/config';

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
import { BeNotifier } from './services/be-notifier';
import type { BeNotifierPort } from './services/be-notifier';

// CX2-1: app-DI 경계도 port 타입 — 실 PairBuffer/BeForwarder 인스턴스는 구조적
// 호환(push/forward 보유)이라 그대로 할당 가능, vi mock도 typecheck:test 통과
export interface IngestDeps {
  pairBuffer: PairBufferPort;
  beForwarder: BeForwarderPort;
}

export function createApp(
  monitor?: HealthMonitor,
  pendingRegistry?: PendingRegistry,
  ingestDeps?: IngestDeps,
  beNotifier?: BeNotifierPort, // 신규 4th optional (backward-compat — 기존 3-arg/무인자 호출 무영향)
): express.Application {
  const app = express();
  const notifier = beNotifier ?? new BeNotifier();
  const registry =
    pendingRegistry ??
    new PendingRegistry(config.PENDING_REGISTRY_TTL_MS, globalThis, (subjectIdx, deUrl) => {
      // default registry도 onEvict 배선 (R-C1). R2-6: as-cast 제거, 런타임 narrow.
      if (subjectIdx !== 1 && subjectIdx !== 2) return;
      notifier.notifyUnregister({ subjectIndex: subjectIdx, engineUrl: deUrl });
    });
  // 생략 시 fresh 생성 — connect 안 함(createApp no-socket 계약 보존, 무인자 부작용 0)
  const pairBuffer = ingestDeps?.pairBuffer ?? new PairBuffer();
  const beForwarder = ingestDeps?.beForwarder ?? new BeForwarder();

  app.use(express.json());
  app.use('/health', createHealthRouter(monitor));
  app.use('/register', createRegisterRouter(registry, { beNotifier: notifier }));
  app.use('/heartbeat', createHeartbeatRouter(monitor)); // factory
  app.use('/ingest', createIngestRouter({ pairBuffer, beForwarder })); // /ingest/sample
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
  // CX-1: BACKEND_URL 미설정 시 BE notify 경로 전체 무동작 (R-C3 재발). 비공백 secret 가드와 별개.
  if (config.BACKEND_URL === '') {
    console.warn(
      '[proxy] BACKEND_URL 미설정 — proxy /register에서 BE pending 미러(R-C3 fix) 무동작. proxy-mode assign-group 트리거 불발 (C2/C3)',
    );
  } else if (config.ENGINE_SECRET_KEY === '') {
    console.warn(
      '[proxy] ENGINE_SECRET_KEY 빈값 + BACKEND_URL 설정됨 — BE notify가 매번 401/403 실패. 4-way 동일 비공백 secret 필요 (C3/Q4)',
    );
  }
  const monitor = new HealthMonitor();
  monitor.start();
  const pairBuffer = new PairBuffer();
  const beForwarder = new BeForwarder();
  connectBeForwarderWithRetry(beForwarder); // 단발 .catch() 아님 (CX-2)
  const beNotifier = new BeNotifier(); // 신규: 단일 공유 인스턴스
  const registry = new PendingRegistry(
    config.PENDING_REGISTRY_TTL_MS,
    globalThis,
    (subjectIdx, deUrl) => {
      // require.main도 onEvict 배선 (R-C1 핵심 fix). R2-6 런타임 narrow.
      if (subjectIdx !== 1 && subjectIdx !== 2) return;
      beNotifier.notifyUnregister({ subjectIndex: subjectIdx, engineUrl: deUrl });
    },
  );
  const app = createApp(monitor, registry, { pairBuffer, beForwarder }, beNotifier);
  app.listen(config.PROXY_PORT, () => {
    console.log(`mind-signal-proxy listening on port ${config.PROXY_PORT}`);
  });
}
