/**
 * Policy AST Evaluator (Phase 6 / C04 / WP-AOS-06)
 *
 * 评估 PolicyCondition AST，返回 boolean。
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 3 章
 *
 * 输入：
 * - condition: PolicyCondition AST 节点
 * - context: JsonValue（通常是 IntentDecision + GoalSpec + ContextManifest 的合并视图）
 *
 * 输出：
 * - boolean：condition 是否匹配
 *
 * 评估规则：
 * - all: 所有 children 都为 true
 * - any: 任一 child 为 true
 * - none: 所有 children 都为 false（NOT）
 * - eq: context[field] === value
 * - neq: context[field] !== value
 * - gt/gte/lt/lte: 数值比较
 * - in: context[field] in value (array)
 * - nin: context[field] not in value (array)
 * - matches: context[field] matches value (regex string)
 * - exists: context[field] exists
 * - not_exists: context[field] does not exist
 */

import type { JsonValue } from '../contracts/json-value.js';
import type {
  PolicyCondition,
  PolicyConditionOperator,
  Policy,
  CompiledPolicy,
  PolicyDecisionType,
} from '../contracts/policy.js';
import { stableHash } from '../contracts/canonical-json.js';

/** AST 评估错误 */
export class PolicyAstError extends Error {
  constructor(
    message: string,
    readonly operator: PolicyConditionOperator,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'PolicyAstError';
  }
}

/** 按路径读取 context 中的字段值 */
function getField(context: JsonValue, field: string): JsonValue | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const parts = field.split('.');
  let current: JsonValue | undefined = context;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, JsonValue>)[part];
    }
  }
  return current;
}

/** 比较 a 和 b 是否相等（深度值比较） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

/** 数值比较 */
function compareNumbers(a: unknown, b: unknown, op: PolicyConditionOperator): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new PolicyAstError(`numeric comparison requires numbers, got ${typeof a} and ${typeof b}`, op);
  }
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: throw new PolicyAstError(`unsupported numeric operator: ${op}`, op);
  }
}

/** 评估单个 AST 节点 */
export function evaluateCondition(condition: PolicyCondition, context: JsonValue): boolean {
  const { operator, field, value, children } = condition;

  switch (operator) {
    case 'all': {
      if (!children || children.length === 0) {
        throw new PolicyAstError('all operator requires non-empty children', operator);
      }
      return children.every((child) => evaluateCondition(child, context));
    }
    case 'any': {
      if (!children || children.length === 0) {
        throw new PolicyAstError('any operator requires non-empty children', operator);
      }
      return children.some((child) => evaluateCondition(child, context));
    }
    case 'none': {
      if (!children || children.length === 0) {
        throw new PolicyAstError('none operator requires non-empty children', operator);
      }
      return !children.some((child) => evaluateCondition(child, context));
    }
    case 'eq': {
      if (field === undefined || value === undefined) {
        throw new PolicyAstError('eq requires field and value', operator, field);
      }
      const actual = getField(context, field);
      return deepEqual(actual, value);
    }
    case 'neq': {
      if (field === undefined || value === undefined) {
        throw new PolicyAstError('neq requires field and value', operator, field);
      }
      const actual = getField(context, field);
      return !deepEqual(actual, value);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (field === undefined || value === undefined) {
        throw new PolicyAstError(`${operator} requires field and value`, operator, field);
      }
      const actual = getField(context, field);
      return compareNumbers(actual, value, operator);
    }
    case 'in': {
      if (field === undefined || value === undefined) {
        throw new PolicyAstError('in requires field and value', operator, field);
      }
      if (!Array.isArray(value)) {
        throw new PolicyAstError('in operator requires value to be array', operator, field);
      }
      const actual = getField(context, field);
      return value.some((item) => deepEqual(actual, item));
    }
    case 'nin': {
      if (field === undefined || value === undefined) {
        throw new PolicyAstError('nin requires field and value', operator, field);
      }
      if (!Array.isArray(value)) {
        throw new PolicyAstError('nin operator requires value to be array', operator, field);
      }
      const actual = getField(context, field);
      return !value.some((item) => deepEqual(actual, item));
    }
    case 'matches': {
      if (field === undefined || typeof value !== 'string') {
        throw new PolicyAstError('matches requires field and string regex value', operator, field);
      }
      const actual = getField(context, field);
      if (typeof actual !== 'string') return false;
      try {
        const regex = new RegExp(value);
        return regex.test(actual);
      } catch (err) {
        throw new PolicyAstError(
          `invalid regex: ${value} (${err instanceof Error ? err.message : String(err)})`,
          operator,
          field,
        );
      }
    }
    case 'exists': {
      if (field === undefined) {
        throw new PolicyAstError('exists requires field', operator, field);
      }
      const actual = getField(context, field);
      return actual !== undefined;
    }
    case 'not_exists': {
      if (field === undefined) {
        throw new PolicyAstError('not_exists requires field', operator, field);
      }
      const actual = getField(context, field);
      return actual === undefined;
    }
    default:
      throw new PolicyAstError(`unsupported operator: ${(operator as string)}`, operator);
  }
}

/** 批量评估多个 conditions（all 语义） */
export function evaluateAll(conditions: readonly PolicyCondition[], context: JsonValue): boolean {
  return conditions.every((cond) => evaluateCondition(cond, context));
}

/** 批量评估多个 conditions（any 语义） */
export function evaluateAny(conditions: readonly PolicyCondition[], context: JsonValue): boolean {
  return conditions.some((cond) => evaluateCondition(cond, context));
}

// ===========================================================================
// Section: Policy Compilation (Policy → CompiledPolicy AST)
// ===========================================================================

/**
 * 编译 Policy 为 CompiledPolicy (AST 形式).
 *
 * 编译过程是纯函数: 不修改输入 Policy, 也不读取外部状态.
 * condition AST 原样保留 (clean 契约使用 operator/field/value/children 形式).
 */
export function compilePolicyToAst(policy: Policy): CompiledPolicy {
  const sourceHash = stableHash(policy.schema, policy as unknown as JsonValue);
  return {
    policyId: policy.policyId,
    version: policy.version,
    priority: policy.priority,
    decision: policy.decision,
    condition: policy.condition,
    requiredActions: policy.requiredActions,
    prohibitedActions: policy.prohibitedActions,
    evidenceRequirements: policy.evidenceRequirements,
    onFailure: policy.onFailure,
    sourceHash,
  };
}

// ===========================================================================
// Section: Policy Decision Evaluation
// ===========================================================================

/** Policy 求值结果 */
export interface PolicyEvaluationResult {
  matched: boolean;
  decision: PolicyDecisionType;
  requiredActions: readonly string[];
  prohibitedActions: readonly string[];
  evidenceRequirements: readonly string[];
  reasonCodes: string[];
}

/**
 * 求值单个 CompiledPolicy 在给定上下文下的决策.
 *
 * 如果条件不匹配, 返回 matched=false 和默认决策 ALLOW.
 * 如果条件匹配, 返回 matched=true 和 Policy 声明的 decision.
 */
export function evaluateCompiledPolicy(
  policy: CompiledPolicy,
  context: JsonValue,
): PolicyEvaluationResult {
  const matched = evaluateCondition(policy.condition, context);
  if (!matched) {
    return {
      matched: false,
      decision: 'ALLOW',
      requiredActions: [],
      prohibitedActions: [],
      evidenceRequirements: [],
      reasonCodes: ['CONDITION_NOT_MATCHED'],
    };
  }
  return {
    matched: true,
    decision: policy.decision,
    requiredActions: policy.requiredActions,
    prohibitedActions: policy.prohibitedActions,
    evidenceRequirements: policy.evidenceRequirements,
    reasonCodes: ['CONDITION_MATCHED'],
  };
}

// ===========================================================================
// Section: AST Immutability Guard
// ===========================================================================

/**
 * 深度冻结 Policy 条件 AST (防止 Skill 文本改写 Policy AST).
 *
 * 设计文档第 8 节 强制规则: Skill 自然语言内容不能修改 Policy.
 * 通过 Object.freeze 在运行时保护 AST 节点.
 */
export function freezeConditionNode<T extends PolicyCondition>(node: T): T {
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      freezeConditionNode(child);
    }
    Object.freeze(node.children);
  }
  if (node.value !== undefined && typeof node.value === 'object' && node.value !== null) {
    Object.freeze(node.value);
  }
  return Object.freeze(node);
}

/**
 * 检查条件 AST 是否被冻结 (用于断言 Skill 文本未改写 Policy AST).
 */
export function isConditionNodeFrozen(node: PolicyCondition): boolean {
  if (!Object.isFrozen(node)) return false;
  if (node.children) {
    if (!Object.isFrozen(node.children)) return false;
    return node.children.every((child) => isConditionNodeFrozen(child));
  }
  return true;
}

// ===========================================================================
// Section: AST Builder Helpers (用于测试和程序化构建)
// ===========================================================================

export function fieldEquals(field: string, value: JsonValue): PolicyCondition {
  return { operator: 'eq', field, value };
}

export function fieldNotEquals(field: string, value: JsonValue): PolicyCondition {
  return { operator: 'neq', field, value };
}

export function fieldIn(field: string, values: readonly JsonValue[]): PolicyCondition {
  return { operator: 'in', field, value: [...values] };
}

export function fieldGreaterThan(field: string, threshold: number): PolicyCondition {
  return { operator: 'gt', field, value: threshold };
}

export function fieldLessThan(field: string, threshold: number): PolicyCondition {
  return { operator: 'lt', field, value: threshold };
}

export function allOf(...children: PolicyCondition[]): PolicyCondition {
  return { operator: 'all', children: [...children] };
}

export function anyOf(...children: PolicyCondition[]): PolicyCondition {
  return { operator: 'any', children: [...children] };
}
