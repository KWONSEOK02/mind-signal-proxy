/**
 * proxy_ingress_ts_ns 소스 — epoch 기준 나노초 십진 문자열 반환함 (CX-1).
 *
 * 모듈 로드 시 epoch base(ms→ns)와 hrtime base를 1회 캡처하고, 호출마다
 * hrtime delta를 더해 epoch 도메인 + sub-ms 단조성을 동시 보장함. BE의
 * failClosedNs = BigInt(Date.now())*1_000_000n (engine-registry.service.ts:53)
 * 과 동일 도메인이라 proxy-ingest.handler.ts:87-88 비교가 유효함.
 */
const _epochBaseNs = BigInt(Date.now()) * 1_000_000n;
const _hrBaseNs = process.hrtime.bigint();

export function nowNs(): string {
  const deltaNs = process.hrtime.bigint() - _hrBaseNs; // 단조 증가, ≥ 0n
  return (_epochBaseNs + deltaNs).toString(); // ≈19자리, /^\d{1,21}$/ 충족
}
