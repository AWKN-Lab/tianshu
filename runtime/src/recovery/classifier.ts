/**
 * Failure Classifier — 失败分类器
 *
 * Spiral 3: 根据错误信息或失败回执判定失败类别与推荐恢复动作。
 *
 * 分类规则：
 *   - network/timeout → TRANSIENT / RETRY
 *   - permission denied → SECURITY / ESCALATE
 *   - assertion/test failure → PERMANENT / REASSIGN
 *   - health check fail → PERMANENT / ROLLBACK
 *   - resource exhausted → RESOURCE / ESCALATE
 *   - unknown → UNKNOWN / ESCALATE
 *
 * 约束：分类器不签署质量或发布 PASS，仅产出分类结果。
 *
 * 对应契约: recovery/contracts.ts — FailureClass / RecoveryAction
 */
import type { FailureClass, RecoveryAction } from './contracts.js';

export interface FailureClassification {
  readonly failureClass: FailureClass;
  readonly recommendedAction: RecoveryAction;
  readonly reason: string;
}

export interface FailureInput {
  /** 错误信息文本（来自异常 message 或回执 error）。 */
  readonly errorMessage?: string;
  /** 失败回执的 verdict（如 FAIL/BLOCKED）。 */
  readonly verdict?: string;
  /** 失败回执的 check_name 或错误类型标签。 */
  readonly errorTag?: string;
}

interface ClassificationRule {
  readonly failureClass: FailureClass;
  readonly recommendedAction: RecoveryAction;
  readonly reason: string;
  /** 返回 true 表示匹配此规则。 */
  readonly match: (input: FailureInput) => boolean;
}

// ─── 分类规则（按优先级顺序）──────────────────────────────

const RULES: readonly ClassificationRule[] = [
  {
    failureClass: 'SECURITY',
    recommendedAction: 'ESCALATE',
    reason: 'permission denied or authorization failure',
    match: (input) =>
      matchesAny(input, ['permission denied', 'unauthorized', 'forbidden', 'access denied', '403', '401']),
  },
  {
    failureClass: 'TRANSIENT',
    recommendedAction: 'RETRY',
    reason: 'network or timeout failure (transient)',
    match: (input) =>
      matchesAny(input, ['timeout', 'timed out', 'network', 'connection refused', 'econnreset', 'econnrefused', '503', '502', 'retryable']),
  },
  {
    failureClass: 'PERMANENT',
    recommendedAction: 'ROLLBACK',
    reason: 'health check failure (deployment unhealthy)',
    match: (input) =>
      matchesAny(input, ['health check', 'unhealthy', 'health_check', 'health-check', 'probe failed']),
  },
  {
    failureClass: 'PERMANENT',
    recommendedAction: 'REASSIGN',
    reason: 'assertion or test failure (permanent)',
    match: (input) =>
      matchesAny(input, ['assertion', 'assert', 'test fail', 'test failure', 'expectation', 'mismatch', 'validation failed']),
  },
  {
    failureClass: 'RESOURCE',
    recommendedAction: 'ESCALATE',
    reason: 'resource exhausted',
    match: (input) =>
      matchesAny(input, ['out of memory', 'oom', 'resource', 'quota', 'disk full', 'capacity', 'rate limit', 'rate_limit']),
  },
];

// ─── 内部辅助 ─────────────────────────────────────────────

function matchesAny(input: FailureInput, patterns: readonly string[]): boolean {
  const haystack = [input.errorMessage ?? '', input.errorTag ?? '']
    .join(' ')
    .toLowerCase();
  if (haystack.length === 0) return false;
  return patterns.some((p) => haystack.includes(p));
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 根据错误信息或失败回执判定失败类别与推荐恢复动作。
 *
 * 按规则优先级匹配；无匹配时返回 UNKNOWN / ESCALATE。
 *
 * 本函数不签署质量或发布 PASS，仅产出分类结果。
 */
export function classifyFailure(input: FailureInput): FailureClassification {
  for (const rule of RULES) {
    if (rule.match(input)) {
      return {
        failureClass: rule.failureClass,
        recommendedAction: rule.recommendedAction,
        reason: rule.reason,
      };
    }
  }
  return {
    failureClass: 'UNKNOWN',
    recommendedAction: 'ESCALATE',
    reason: 'unknown failure type',
  };
}
