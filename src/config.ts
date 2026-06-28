const getNum = (key: string, defaultVal: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${key}=${raw}`);
  return parsed;
};

const getString = (key: string, defaultVal = ''): string => process.env[key] ?? defaultVal;

const FAIL_CLOSED_THRESHOLD_MS = getNum('FAIL_CLOSED_THRESHOLD_MS', 3000);
const HEARTBEAT_INTERVAL_MS = getNum('HEARTBEAT_INTERVAL_MS', 1000);

if (FAIL_CLOSED_THRESHOLD_MS <= HEARTBEAT_INTERVAL_MS) {
  throw new Error(
    `FAIL_CLOSED_THRESHOLD_MS (${FAIL_CLOSED_THRESHOLD_MS}) must be > HEARTBEAT_INTERVAL_MS (${HEARTBEAT_INTERVAL_MS})`,
  );
}

export const config = {
  PROXY_PORT: getNum('PROXY_PORT', 5050),
  BACKEND_URL: getString('BACKEND_URL'),
  ENGINE_SECRET_KEY: getString('ENGINE_SECRET_KEY'),
  FAIL_CLOSED_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
  PAIR_BUFFER_SIZE: getNum('PAIR_BUFFER_SIZE', 1024),
  PAIRED_WINDOW_MS: getNum('PAIRED_WINDOW_MS', 100),
  BE_FORWARD_QUEUE_MAX: getNum('BE_FORWARD_QUEUE_MAX', 512),
  PENDING_REGISTRY_TTL_MS: getNum('PENDING_REGISTRY_TTL_MS', 600000),
} as const;
