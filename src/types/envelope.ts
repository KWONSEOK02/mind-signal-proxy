import { z } from 'zod';

export const WavePowerSchema = z.object({
  delta: z.number(),
  theta: z.number(),
  alpha: z.number(),
  beta: z.number(),
  gamma: z.number(),
});

// EMOTIV 지표 6종. DE가 metrics를 실어 보내지 않던 시절의 프레임과
// 호환하려고 optional로 둠. 미전달 시 하류(FE 차트)가 대역 파워를 지표로
// 오표시하므로 라이브 경로에서는 항상 채워짐 (2026-07-10 결함 수정).
export const EmotivMetricsSchema = z.object({
  focus: z.number(),
  engagement: z.number(),
  interest: z.number(),
  excitement: z.number(),
  stress: z.number(),
  relaxation: z.number(),
});

export const SampleEnvelopeSchema = z.object({
  group_id: z.string(),
  subject_idx: z.number().int(),
  de_ts_ns: z.string().regex(/^\d{1,21}$/),
  proxy_ingress_ts_ns: z.string().regex(/^\d{1,21}$/),
  seq: z.number().int(),
  payload: WavePowerSchema,
  metrics: EmotivMetricsSchema.optional(),
  sync_meta: z.record(z.string(), z.unknown()),
});

export type SampleEnvelope = z.infer<typeof SampleEnvelopeSchema>;
