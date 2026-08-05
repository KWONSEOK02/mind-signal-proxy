# mind-signal-proxy

EEG 데이터 프록시 서버 (Node 20+, TypeScript, Express, Zod, socket.io-client).

`/register`, `/heartbeat`, `/ingest`, `/control/assign-group` 엔드포인트가 배선돼 실제 서비스 로직을 수행합니다(`src/tests/index.wiring.test.ts`가 501이 아님을 단언). 현행 계약은 `../docs/architecture/api-contract.md`의 프록시 경유 계약 절, 4레포 공통 제품 문서는 `../docs/`, 작업 상태 정본은 `../.plans/DASHBOARD.md`입니다.

---

## Operator-PC 설치 가이드

### 전제 조건

- Node.js 20 이상 설치
- npm 10 이상

### 설치 및 실행

```bash
# 의존성 설치 (lockfile 기준 재현 설치)
npm ci

# 전체 검증 (format:check → lint → typecheck → test → build)
npm run verify

# 개발 서버 기동 (ts-node 방식, hot-reload 없음)
npm run dev
```

### 환경 변수 설정

`.env.example`을 복사해 `.env` 파일 생성 후 값 입력:

```bash
cp .env.example .env
```

| 변수                | 기본값 | 설명                              |
| ------------------- | ------ | --------------------------------- |
| `PROXY_PORT`        | `5050` | 프록시 리스닝 포트                |
| `BACKEND_URL`       | (필수) | mind-signal-backend WebSocket URL |
| `ENGINE_SECRET_KEY` | (필수) | DE↔Proxy 인증 키                  |

---

## 필수 환경 조건 (RULE-1 ~ RULE-7)

- **RULE-1**: wired Ethernet — 노트북 B → 운영자 PC만 (DE_A↔Proxy는 loopback = 네트워크 jitter 0)
- **RULE-2**: dedicated LAN segment — 운영자 PC와 노트북 B 간 1개 wired link만 (스위치 또는 직접 LAN 케이블)
- **RULE-3**: fixed IP + KnownPeers 박제 — 노트북 B IP 고정 (discovery jitter 회피)
- **RULE-4**: WiFi 5-GHz 사용 시 Bluetooth 간섭 회피 (Cortex BT 신뢰성)
- **RULE-5**: effective_srate ≤ 0.01% 편차 모니터 (Mongo schema 의무 + alert)
- **RULE-6**: 5–30ms chunk size sweet spot, 100ms 초과 금지 (LSL 권고)
- **RULE-7**: stimulus broadcast = LAN-internal fan-out (프록시가 DE_A=loopback / DE_B=wired LAN 동시 송신 → jitter 최소화)

---

## 스크립트 목록

| 명령                   | 설명                        |
| ---------------------- | --------------------------- |
| `npm run build`        | TypeScript 컴파일 (`dist/`) |
| `npm start`            | 컴파일 결과 실행            |
| `npm run dev`          | tsx로 직접 실행 (개발용)    |
| `npm run typecheck`    | 타입 체크 (emit 없음)       |
| `npm run lint`         | ESLint 검사                 |
| `npm run format`       | Prettier 포맷 적용          |
| `npm run format:check` | Prettier 포맷 검사          |
| `npm test`             | Vitest 테스트 실행          |
| `npm run verify`       | 전체 검증 파이프라인        |
