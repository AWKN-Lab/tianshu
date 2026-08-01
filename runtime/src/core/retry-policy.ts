/**
 * awkn-engine — 瞬态错误重试策略（技能吸收 P1-3）
 *
 * 只对瞬态错误（网络抖动、速率限制、服务端 5xx）重试；
 * 非瞬态错误（语法错误、权限、4xx 客户端错误）直接放弃，避免无意义重试。
 */

const TRANSIENT_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_ERRNO = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
  'EHOSTUNREACH',
]);

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /quota exhausted/i,
  /temporarily unavailable/i,
  /transient error/i,
  /connect etimedout/i,
  /socket hang up/i,
  /read econnreset/i,
];

/** 从任意错误提取 errno/code/status（兼容 Node Error、Axios/HTTP 封装） */
function errorSignature(error: unknown): { errno?: string; code?: string; status?: number } {
  const value = error as Record<string, unknown>;
  if (typeof value?.code === 'string' && /^[45]\d\d$/.test(value.code)) {
    return { status: Number(value.code) };
  }
  return {
    errno: typeof value?.errno === 'string' ? value.errno : undefined,
    code: typeof value?.code === 'string' ? value.code : undefined,
    status: typeof value?.status === 'number' ? value.status : undefined,
  };
}

/** 判定错误是否为瞬态错误（可安全重试） */
export function isTransientError(error: unknown): boolean {
  const { errno, code, status } = errorSignature(error);
  if (status !== undefined && TRANSIENT_HTTP_CODES.has(status)) return true;
  if (code !== undefined && TRANSIENT_ERRNO.has(code)) return true;
  if (errno !== undefined && TRANSIENT_ERRNO.has(errno)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/** 是否应重试：瞬态错误且尝试次数未达上限 */
export function shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
  return isTransientError(error) && attempt < maxAttempts;
}

/** 指数退避延迟（毫秒），带 ±20% 抖动；上限 maxMs */
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(exponential + jitter));
}
