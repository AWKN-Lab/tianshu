/**
 * 简易 logger — 不依赖外部库
 *
 * 输出到 stderr，不打扰 stdout 的结构化输出
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: LogLevel =
  (process.env.AWKN_LOG_LEVEL as LogLevel) ?? 'info';

function log(level: LogLevel, tag: string, msg: string, meta?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) return;

  const ts = new Date().toISOString();
  const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}${metaStr}\n`);
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, meta?: unknown) => log('debug', tag, msg, meta),
    info: (msg: string, meta?: unknown) => log('info', tag, msg, meta),
    warn: (msg: string, meta?: unknown) => log('warn', tag, msg, meta),
    error: (msg: string, meta?: unknown) => log('error', tag, msg, meta),
  };
}

export const logger = createLogger('runtime');
