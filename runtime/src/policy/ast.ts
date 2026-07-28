/**
 * Policy AST 节点和条件求值器 (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 3, 6 节
 *
 * 职责:
 * - 提供 Policy 条件 AST 的运行时求值器
 * - 支持点号分隔的 field 路径 (如 `action.sideEffect`)
 * - 编译 Policy 为 CompiledPolicy (AST 形式)
 *
 * 设计原则:
 * - Skill 文本不能改写 Policy AST (设计文档第 8 节 强制规则)
 * - 条件求值是纯函数, 无副作用
 */

import type {
  CompiledPolicy,
  Policy,
  PolicyConditionLeaf,
  PolicyConditionNode,
  PolicyDecision,
} from '../contracts/policy.js';
import type { JsonValue } from '../contracts/json-value.js';

// ===========================================================================
// Section 1: Field Resolution
// ===========================================================================

/**
 * 从上下文中按点号分隔路径获取字段值.
 *
 * 例: getField({ action: { sideEffect: 'external_write' } }, 'action.sideEffect')
 *   → 'external_write'
 *
 * 不存在时返回 undefined.
 */
export function resolveField(context: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const segments = path.split('.');
  let current: unknown = context;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ===========================================================================
// Section 2: Condition Leaf Evaluation
// ===========================================================================

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>).sort();
    const rightKeys = Object.keys(right as Record<string, unknown>).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      valuesEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

function evaluateLeaf(leaf: PolicyConditionLeaf, context: Record<string, unknown>): boolean {
  const value = resolveField(context, leaf.field);
  if (leaf.equals !== undefined) {
    return valuesEqual(value, leaf.equals);
  }
  if (leaf.notEquals !== undefined) {
    return !valuesEqual(value, leaf.notEquals);
  }
  if (leaf.in !== undefined) {
    return leaf.in.some((item) => valuesEqual(value, item));
  }
  if (leaf.gt !== undefined) {
    return typeof value === 'number' && value > leaf.gt;
  }
  if (leaf.lt !== undefined) {
    return typeof value === 'number' && value < leaf.lt;
  }
  // 不应该到这里, schema 校验保证至少有一个操作符
  return false;
}

// ===========================================================================
// Section 3: Condition AST Evaluation
// ===========================================================================

/**
 * 求值 Policy 条件 AST.
 *
 * - 叶子节点: 按 field/equals/notEquals/in/gt/lt 求值
 * - { all: [...] }: 所有子条件都满足
 * - { any: [...] }: 任一子条件满足
 */
export function evaluateCondition(
  node: PolicyConditionNode,
  context: Record<string, unknown>,
): boolean {
  if ('all' in node) {
    return node.all.every((child) => evaluateCondition(child, context));
  }
  if ('any' in node) {
    return node.any.some((child) => evaluateCondition(child, context));
  }
  return evaluateLeaf(node, context);
}

// ===========================================================================
// Section 4: Policy Compilation (Policy → CompiledPolicy AST)
// ===========================================================================

/**
 * 编译 Policy 为 CompiledPolicy (AST 形式).
 *
 * 设计文档第 13 节 UPGRADE:
 * - ToolPolicy 成为 Policy Evaluator Adapter
 * - Skills Manager 输出 SkillRef 和版本 Hash
 * - Gate 定义进入 Skill Manifest 引用
 *
 * 编译过程是纯函数: 不修改输入 Policy, 也不读取外部状态.
 */
export function compilePolicyToAst(policy: Policy): CompiledPolicy {
  return {
    schema: 'awkn-compiled-policy/v1',
    policyId: policy.policyId,
    version: policy.version,
    source: policy.source,
    priority: policy.priority,
    decision: policy.decision,
    conditionAst: policy.condition,
    requiredActions: policy.requiredActions,
    prohibitedActions: policy.prohibitedActions,
    evidenceRequirements: policy.evidenceRequirements,
    onFailure: policy.onFailure,
  };
}

// ===========================================================================
// Section 5: Policy Decision Evaluation
// ===========================================================================

/**
 * Policy 求值结果
 */
export interface PolicyEvaluationResult {
  matched: boolean;
  decision: PolicyDecision;
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
  context: Record<string, unknown>,
): PolicyEvaluationResult {
  const matched = evaluateCondition(policy.conditionAst, context);
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
// Section 6: AST Immutability Guard
// ===========================================================================

/**
 * 深度冻结 Policy 条件 AST (防止 Skill 文本改写 Policy AST).
 *
 * 设计文档第 8 节 强制规则: Skill 自然语言内容不能修改 Policy.
 * 通过 Object.freeze 在运行时保护 AST 节点.
 */
export function freezeConditionNode<T extends PolicyConditionNode>(node: T): T {
  if ('all' in node) {
    node.all.forEach(freezeConditionNode);
    Object.freeze(node.all);
  } else if ('any' in node) {
    node.any.forEach(freezeConditionNode);
    Object.freeze(node.any);
  }
  return Object.freeze(node);
}

/**
 * 检查条件 AST 是否被冻结 (用于断言 Skill 文本未改写 Policy AST).
 */
export function isConditionNodeFrozen(node: PolicyConditionNode): boolean {
  if ('all' in node) {
    return Object.isFrozen(node.all) && node.all.every(isConditionNodeFrozen);
  }
  if ('any' in node) {
    return Object.isFrozen(node.any) && node.any.every(isConditionNodeFrozen);
  }
  return Object.isFrozen(node);
}

// ===========================================================================
// Section 7: AST Builder Helpers (用于测试和程序化构建)
// ===========================================================================

export function fieldEquals(field: string, value: JsonValue): PolicyConditionLeaf {
  return { field, equals: value };
}

export function fieldNotEquals(field: string, value: JsonValue): PolicyConditionLeaf {
  return { field, notEquals: value };
}

export function fieldIn(field: string, values: readonly JsonValue[]): PolicyConditionLeaf {
  return { field, in: [...values] };
}

export function fieldGreaterThan(field: string, threshold: number): PolicyConditionLeaf {
  return { field, gt: threshold };
}

export function fieldLessThan(field: string, threshold: number): PolicyConditionLeaf {
  return { field, lt: threshold };
}

export function allOf(...children: PolicyConditionNode[]): PolicyConditionNode {
  return { all: [...children] };
}

export function anyOf(...children: PolicyConditionNode[]): PolicyConditionNode {
  return { any: [...children] };
}
