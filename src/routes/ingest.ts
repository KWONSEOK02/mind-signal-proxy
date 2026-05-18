import { Router } from 'express';
import { config } from '../config';
import { SampleEnvelopeSchema } from '../types/envelope';
import type { SampleEnvelope } from '../types/envelope';
import type { PushOutcome } from '../services/pair-buffer';
import { nowNs } from '../services/ingress-clock';

/** CX-3: concrete 클래스 아닌 narrow structural port — vi mock 직접 할당 + ADR §C 최소 의존 */
export interface PairBufferPort {
  push(envelope: SampleEnvelope): PushOutcome;
}
export interface BeForwarderPort {
  forward(envelope: SampleEnvelope): void;
}

export interface IngestRouterDeps {
  pairBuffer: PairBufferPort;
  beForwarder: BeForwarderPort;
  ingressClock?: () => string; // 기본 nowNs (ingress-clock.ts)
  engineSecret?: string; // 기본 config.ENGINE_SECRET_KEY
}

/**
 * DE→Proxy 샘플 인그레스 라우터 생성함 (T1-PXW-B, 부모 PLAN L189·ADR §C).
 * route: POST /sample (mount /ingest → /ingest/sample, DE proxy_client.py:134 정합).
 * ADR §C: 프록시 무정렬 — proxy_ingress_ts_ns 부여 + buffer/seq + BeForwarder 전달만.
 * @param deps pairBuffer/beForwarder(port, 의무) + ingressClock/engineSecret(옵션 DI)
 * @returns Express Router
 */
export function createIngestRouter(deps: IngestRouterDeps): Router {
  const { pairBuffer, beForwarder } = deps;
  const ingressClock = deps.ingressClock ?? nowNs;
  const engineSecret = deps.engineSecret ?? config.ENGINE_SECRET_KEY;
  const router = Router();

  router.post('/sample', (req, res) => {
    // 1. X-Engine-Secret 인증 — 빈 시크릿/불일치 fail-closed deny (register.ts:37-41, D14)
    const inbound = req.headers['x-engine-secret'];
    if (engineSecret === '' || inbound !== engineSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // 2. proxy_ingress_ts_ns(epoch-domain) 부여 후 전체 envelope 검증
    const candidate = { ...req.body, proxy_ingress_ts_ns: ingressClock() };
    const parsed = SampleEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.issues });
      return;
    }
    const envelope = parsed.data;
    // 3. PairBuffer 경유 — seq WARN + bounded drop + sync_meta drop 주석 (QoS만, CX-3 fix)
    pairBuffer.push(envelope);
    // 4. 모든 admit 샘플 즉시 BE 전달 (DISCUSS Q1 LOCK, ADR §C: BE flush() 유일 aligner)
    beForwarder.forward(envelope);
    // 5. 2xx — DE raise_for_status 통과 (BE ack/retry/replay는 BeForwarder 독립 관할)
    res.status(200).json({ ok: true });
  });

  return router;
}
