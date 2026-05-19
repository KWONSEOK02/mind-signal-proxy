import { config } from '../config';

/** 라우터/onEvict가 의존하는 narrow port (18.2 PairBufferPort/BeForwarderPort 패턴). */
export interface BeNotifierPort {
  notifyRegister(args: { subjectIndex: 1 | 2; engineUrl: string }): void;
  notifyUnregister(args: { subjectIndex: 1 | 2; engineUrl: string }): void;
}

export type NotifyState = 'idle' | 'ok' | 'pending' | 'failed';

/** 테스트 결정론 주입형 fetch/타이머 (18.2 DI 패턴). */
export interface BeNotifierDeps {
  backendUrl?: string; // 기본 config.BACKEND_URL
  engineSecret?: string; // 기본 config.ENGINE_SECRET_KEY
  fetchFn?: typeof fetch; // 기본 globalThis.fetch
  // CX5-1: clearable 핸들 반환(void 아님 — backoffHandles/timeoutHandles Map 저장·clearTimeout 대상).
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  //   기본 (cb,ms)=>{ const t=setTimeout(cb,ms); t.unref?.(); return t; }
  maxAttempts?: number; // 기본 3 (DE app.py range(3) 미러)
  timeoutMs?: number; // 기본 2000. per-attempt fetch timeout
}

export class BeNotifier implements BeNotifierPort {
  private closed = false; // R4-1/CX4-1 terminal flag
  private readonly state = new Map<number, NotifyState>();
  private readonly pendingOp = new Map<number, { method: 'POST' | 'DELETE'; engineUrl: string }>();
  private readonly running = new Set<number>();
  private readonly backoffHandles = new Map<number, ReturnType<typeof setTimeout>>(); // R2-2 leak 차단
  private readonly timeoutHandles = new Map<number, ReturnType<typeof setTimeout>>(); // CX5-1 per-attempt fetch timeout 추적
  private readonly backoffResolvers = new Map<number, () => void>(); // R4-1 await 해제용
  private readonly abortControllers = new Map<number, AbortController>(); // R4-1/CX4-1 in-flight 중단

  // resolved deps (computed once)
  private readonly backendUrl: string;
  private readonly engineSecret: string;
  private readonly fetchFn: typeof fetch;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: BeNotifierDeps = {}) {
    this.backendUrl = deps.backendUrl ?? config.BACKEND_URL;
    this.engineSecret = deps.engineSecret ?? config.ENGINE_SECRET_KEY;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.setTimer =
      deps.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.timeoutMs = deps.timeoutMs ?? 2000;
  }

  getState(subjectIndex: 1 | 2): NotifyState {
    return this.state.get(subjectIndex) ?? 'idle';
  }

  notifyRegister(args: { subjectIndex: 1 | 2; engineUrl: string }): void {
    this.enqueue(args.subjectIndex, { method: 'POST', engineUrl: args.engineUrl });
  }
  notifyUnregister(args: { subjectIndex: 1 | 2; engineUrl: string }): void {
    this.enqueue(args.subjectIndex, { method: 'DELETE', engineUrl: args.engineUrl });
  }

  /** latest-wins: 최신 op만 보관, 루프 미가동 시 기동 (per-subject 단일 in-flight). */
  private enqueue(idx: 1 | 2, op: { method: 'POST' | 'DELETE'; engineUrl: string }): void {
    if (this.closed) return; // terminal 후 신규 무시
    this.pendingOp.set(idx, op); // 덮어쓰기 = coalesce to latest
    if (!this.running.has(idx)) {
      this.running.add(idx);
      void this.runLoop(idx).catch(() => {
        /* 내부 전 경로 catch — 누출 0 */
      });
    }
  }

  /** subjectIndex별 직렬 처리: 한 번에 1개 in-flight, settle 후 최신 pendingOp 재독. */
  private async runLoop(idx: 1 | 2): Promise<void> {
    try {
      while (!this.closed && this.pendingOp.has(idx)) {
        const op = this.pendingOp.get(idx)!;
        this.pendingOp.delete(idx); // take (실행 중 새 notify는 다시 set됨)
        await this.attempt(idx, op); // retry/backoff/timeout/status 분류·state·log
      }
    } finally {
      this.running.delete(idx);
      // 방어: 현 설계상 while-exit과 finally 사이 yield 없어 미도달이나, 미래 refactor가
      // finally 앞에 await 추가 시 lost-wakeup 차단 (R4-2 — dead-now/future-safe, race 주장 아님).
      if (!this.closed && this.pendingOp.has(idx)) this.enqueue(idx, this.pendingOp.get(idx)!);
    }
  }

  /** R2-2/R4-1/CX4-1: 진짜 terminal — in-flight fetch abort 그리고 backoff await 즉시 해제 그리고 전 큐/타이머 clear.
   *  테스트 teardown 전용, 호출 후 인스턴스 폐기(재사용 금지 — afterEach마다 new). */
  abortAll(): void {
    this.closed = true;
    for (const c of this.abortControllers.values()) c.abort();
    for (const h of this.timeoutHandles.values()) clearTimeout(h); // CX5-1: per-attempt timeout 타이머도 clear
    for (const h of this.backoffHandles.values()) clearTimeout(h);
    for (const r of this.backoffResolvers.values()) r(); // stuck await 즉시 해제, closed 가드에서 종료
    this.abortControllers.clear();
    this.timeoutHandles.clear();
    this.backoffHandles.clear();
    this.backoffResolvers.clear();
    this.pendingOp.clear();
    this.running.clear();
  }

  private async attempt(
    idx: 1 | 2,
    op: { method: 'POST' | 'DELETE'; engineUrl: string },
  ): Promise<void> {
    // R4-1 guard (1): attempt() entry
    if (this.closed) return;

    // CX-1: backendUrl 미설정 시 fetch 시도 없이 즉시 실패
    if (this.backendUrl === '') {
      this.state.set(idx, 'failed');
      const verb = op.method === 'POST' ? 'register' : 'unregister';
      console.error(
        `[be-notifier] ${verb} notify FAILED subjectIndex=${idx} reason=missing_backend_url`,
      );
      return;
    }

    const verb = op.method === 'POST' ? 'register' : 'unregister';
    const endpoint = `${this.backendUrl}/api/engine/register-pending`;
    const body = JSON.stringify({
      subjectIndex: idx,
      engineUrl: op.engineUrl,
      secretKey: this.engineSecret,
    });

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      // R4-1 guard (4): before re-entering the retry loop (applies from 2nd iteration)
      if (this.closed) return;

      // CX-2/R2-8/CX5-1: per-attempt AbortController + timeout timer
      const ctrl = new AbortController();
      this.abortControllers.set(idx, ctrl);
      const tH = this.setTimer(
        () => ctrl.abort(new DOMException('timeout', 'TimeoutError')),
        this.timeoutMs,
      );
      this.timeoutHandles.set(idx, tH);

      let retryable = false;
      let succeeded = false;
      let httpStatus: number | undefined;
      let errorName: string | undefined;

      try {
        const res = await this.fetchFn(endpoint, {
          method: op.method,
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: ctrl.signal,
        });

        httpStatus = res.status;

        if (res.ok) {
          // success (2xx)
          succeeded = true;
        } else if (
          res.status === 400 ||
          res.status === 401 ||
          res.status === 403 ||
          res.status === 404 ||
          res.status === 422
        ) {
          // non-retry: permanent client error
          retryable = false;
        } else if (res.status === 408 || res.status === 429 || res.status >= 500) {
          // retryable: server/rate-limit/timeout
          retryable = true;
        } else {
          // 3xx or other unexpected: non-retry
          retryable = false;
          httpStatus = res.status; // preserve for reason
        }
      } catch (err: unknown) {
        const name = err instanceof Error ? err.name : '';
        errorName = name;

        // closed 상태에서 fetch가 abort된 경우: terminal return (state/log/retry 없음)
        if (ctrl.signal.aborted && this.closed) {
          // CX5-1: clear timeout timer even on abort path
          clearTimeout(this.timeoutHandles.get(idx));
          this.timeoutHandles.delete(idx);
          this.abortControllers.delete(idx);
          return;
        }

        // TimeoutError or AbortError from non-closed abort (e.g. our per-attempt timeout)
        if (name === 'TimeoutError' || name === 'AbortError') {
          retryable = true;
        } else {
          // transport-level error (ECONNREFUSED, etc.)
          retryable = true;
        }
      } finally {
        // CX5-1: clear timeout timer on the normal/fast path
        clearTimeout(this.timeoutHandles.get(idx));
        this.timeoutHandles.delete(idx);
        this.abortControllers.delete(idx);
      }

      // R4-1 guard (3): before any state/log write
      if (this.closed) return;

      if (succeeded) {
        this.state.set(idx, 'ok');
        console.log(`[be-notifier] ${verb} notify ok subjectIndex=${idx} url=${op.engineUrl}`);
        return;
      }

      if (!retryable) {
        // non-retry: permanent failure
        this.state.set(idx, 'failed');
        let reason: string;
        if (httpStatus !== undefined) {
          if (httpStatus >= 300 && httpStatus < 400) {
            reason = 'unexpected_redirect';
          } else {
            reason = `http_${httpStatus}`;
          }
        } else {
          reason = `http_unknown`;
        }
        console.error(`[be-notifier] ${verb} notify FAILED subjectIndex=${idx} reason=${reason}`);
        return;
      }

      // retryable path: more attempts remaining?
      const nextAttempt = attempt + 1;
      if (nextAttempt >= this.maxAttempts) {
        // exhausted
        // R4-1 guard (3) already checked above; check again to be safe
        if (this.closed) return;
        this.state.set(idx, 'failed');
        console.error(`[be-notifier] ${verb} notify FAILED subjectIndex=${idx} reason=exhausted`);
        return;
      }

      // set state to pending while retrying, log retry
      this.state.set(idx, 'pending');
      const statusStr = httpStatus !== undefined ? String(httpStatus) : errorName || 'unknown';
      console.error(
        `[be-notifier] ${verb} notify retry ${nextAttempt}/${this.maxAttempts} subjectIndex=${idx} status=${statusStr}`,
      );

      // cancellable backoff: 1000 * 2^attempt ms (1000 before 2nd attempt, 2000 before 3rd)
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise<void>((r) => {
        this.backoffResolvers.set(idx, r);
        this.backoffHandles.set(
          idx,
          this.setTimer(() => {
            this.backoffResolvers.delete(idx);
            r();
          }, delay),
        );
      });
      this.backoffHandles.delete(idx);

      // R4-1 guard (2): immediately after backoff resolves
      if (this.closed) return;
    }
  }
}
