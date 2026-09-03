import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import { AddressInfo } from 'net';
import { BeForwarder } from '../services/be-forwarder';
import type { SampleEnvelope } from '../types/envelope';

const TEST_SECRET = 'test-secret-abc';

/**
 * Regression cover for the 2026-09-03 blind spot: a subject stopped reaching the
 * backend and nothing in BeForwarder logged anything, so the hop could not be found.
 * The summary line is the signal — assert it carries the per-subject tally.
 */
function makeEnvelope(seq: number, subjectIdx: number, groupId = 'g1'): SampleEnvelope {
  return {
    group_id: groupId,
    subject_idx: subjectIdx,
    de_ts_ns: '1700000000000000000',
    proxy_ingress_ts_ns: '1700000000001000000',
    seq,
    payload: { delta: 0.1, theta: 0.2, alpha: 0.3, beta: 0.4, gamma: 0.5 },
    sync_meta: {},
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('BeForwarder — per-subject summary log', () => {
  let forwarder: BeForwarder;
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    forwarder?.disconnect();
    if (shutdown) await shutdown();
    shutdown = null;
    vi.restoreAllMocks();
  });

  it('두 subject의 forward와 ack 결과를 subject별 한 줄로 요약함', async () => {
    const httpServer = createServer();
    const ioServer = new SocketIoServer(httpServer);
    ioServer.of('/proxy').on('connection', (socket) => {
      socket.on('proxy:sample', (_envelope: unknown, ack: (a: unknown) => void) =>
        ack({ ok: true }),
      );
    });
    shutdown = () =>
      new Promise<void>((resolve) => {
        ioServer.close(() => httpServer.close(() => resolve()));
      });
    const serverUrl = await new Promise<string>((resolve) => {
      httpServer.listen(0, () =>
        resolve(`http://localhost:${(httpServer.address() as AddressInfo).port}`),
      );
    });

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    // 50ms 간격 — 프로덕션 기본값 10초로는 테스트가 성립하지 않는다
    forwarder = new BeForwarder(50);
    await forwarder.connect(serverUrl, TEST_SECRET);

    forwarder.forward(makeEnvelope(1, 1));
    forwarder.forward(makeEnvelope(1, 2));
    forwarder.forward(makeEnvelope(2, 2));
    await delay(300);

    const summaries = logged.filter((l) => l.includes('[BeForwarder] summary'));
    const subject1 = summaries.find((l) => l.includes('subject=1'));
    const subject2 = summaries.find((l) => l.includes('subject=2'));

    expect(subject1).toBeDefined();
    expect(subject2).toBeDefined();
    expect(subject1).toContain('forwarded=1');
    expect(subject2).toContain('forwarded=2');
    // ack 집계까지 봐야 함. forwarded 만 보면 ackOk 증가가 사라지거나 엉뚱한
    // subject 로 기록돼도 통과함 (CodeRabbit PR #8)
    expect(subject1).toContain('ackOk=1');
    expect(subject2).toContain('ackOk=2');
    // group_id 불일치가 이 로그의 핵심 판별점이다
    expect(subject1).toContain('groups=[g1]');
    expect(subject1).toContain('connected=true');
  });

  it('샘플이 끊긴 subject도 forwarded=0으로 계속 보고함 — 침묵과 정상을 구분하기 위함', async () => {
    const httpServer = createServer();
    const ioServer = new SocketIoServer(httpServer);
    ioServer.of('/proxy').on('connection', (socket) => {
      socket.on('proxy:sample', (_envelope: unknown, ack: (a: unknown) => void) =>
        ack({ ok: true }),
      );
    });
    shutdown = () =>
      new Promise<void>((resolve) => {
        ioServer.close(() => httpServer.close(() => resolve()));
      });
    const serverUrl = await new Promise<string>((resolve) => {
      httpServer.listen(0, () =>
        resolve(`http://localhost:${(httpServer.address() as AddressInfo).port}`),
      );
    });

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    forwarder = new BeForwarder(50);
    await forwarder.connect(serverUrl, TEST_SECRET);

    forwarder.forward(makeEnvelope(1, 1));
    await delay(300);

    const zeroLines = logged.filter(
      (l) =>
        l.includes('[BeForwarder] summary') && l.includes('subject=1') && l.includes('forwarded=0'),
    );
    expect(zeroLines.length).toBeGreaterThan(0);
  });
});
