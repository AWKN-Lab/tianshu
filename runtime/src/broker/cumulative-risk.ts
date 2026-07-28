/**
 * Cumulative Risk Calculator (Phase 6 / C05 / WP-AOS-08)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 8 节
 *
 * 单次动作风险与会话组合风险分开计算:
 *
 * ```text
 * CumulativeRisk =
 *   BaseActionRisk
 *   + DataAggregationRisk
 *   + Irreversibility
 *   + CrossSystemPropagation
 *   + FinancialImpact
 *   + IdentityRepresentation
 *   + RepetitionFactor
 *   - VerifiedCompensation
 * ```
 *
 * 示例:
 *   读取联系人 R1 + 读取日历 R1 + 生成外发内容 R1 + 发送邮件 R3
 *   → 累计风险可能提升到 R4
 *
 * 达到阈值后触发:
 *   - 更高授权
 *   - 参数摘要
 *   - 二次确认
 *   - 人工审核
 *   - 限制批量数量
 *   - 禁止自动重试
 */

import type { RiskSnapshot, ToolRiskLevel, ToolRoutePlan } from '../contracts/broker.js';

/** 风险等级对应的数值 (R0=0, R5=5), 用于累加计算 */
const RISK_LEVEL_VALUE: Record<ToolRiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
};

const VALUE_TO_RISK_LEVEL: ToolRiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];

/**
 * 将数值映射回风险等级, 并 clamp 到 [R0, R5]
 */
function valueToRiskLevel(value: number): ToolRiskLevel {
  const clamped = Math.max(0, Math.min(5, Math.trunc(value)));
  return VALUE_TO_RISK_LEVEL[clamped]!;
}

/**
 * 计算单个 ToolRoute 的有效基础风险
 *
 * 注意: irreversibility 已作为独立维度在 computeCumulativeRisk 中计算,
 * 此处不重复加成 (避免双重计数).
 * 仅考虑 riskBase + 重复因子.
 */
export function computeBaseActionRisk(
  toolRoute: ToolRoutePlan,
  repetitionCount: number,
): ToolRiskLevel {
  const base = RISK_LEVEL_VALUE[toolRoute.riskBase];
  // 重复因子: 重复执行放大风险, 但封顶 +2
  const repetitionBonus = Math.min(Math.max(0, repetitionCount - 1), 2);
  return valueToRiskLevel(base + repetitionBonus);
}

/**
 * 计算累计风险快照
 *
 * @param toolRoutes 当前 plan 中所有工具路由
 * @param repetitionMap 每个 toolId 的累计调用次数
 * @param verifiedCompensation 是否已验证补偿方案 (例如: 已有 rollback 计划)
 */
export function computeCumulativeRisk(
  toolRoutes: readonly ToolRoutePlan[],
  repetitionMap: ReadonlyMap<string, number>,
  verifiedCompensation: boolean,
): RiskSnapshot {
  if (toolRoutes.length === 0) {
    // fail-closed: 没有工具时, 累计风险为 R0 (纯本地计算)
    return {
      schema: 'awkn-risk-snapshot/v1',
      baseActionRisk: 'R0',
      dataAggregationRisk: 'R0',
      irreversibility: 'R0',
      crossSystemPropagation: 'R0',
      financialImpact: 'R0',
      identityRepresentation: 'R0',
      repetitionFactor: 0,
      verifiedCompensation,
      cumulativeRisk: 'R0',
    };
  }

  // 计算每个路由的有效基础风险
  const effectiveRisks = toolRoutes.map((route) => {
    const repCount = repetitionMap.get(route.toolId) ?? 1;
    return computeBaseActionRisk(route, repCount);
  });

  // 取最大值作为 baseActionRisk (代表最危险的单个动作)
  const maxBase = Math.max(...effectiveRisks.map((r) => RISK_LEVEL_VALUE[r]));

  // 数据聚合风险: 不同工具写入的数据范围数量 (粗略估算)
  const writeDataScopes = new Set<string>();
  let crossSystemCount = 0;
  let hasFinancial = false;
  let hasIdentity = false;
  for (const route of toolRoutes) {
    // 通过 sideEffect 推断数据范围和跨系统传播
    // 所有 external_* side effect 都视为跨系统传播
    if (
      route.sideEffect === 'external_read' ||
      route.sideEffect === 'external_write' ||
      route.sideEffect === 'external_send'
    ) {
      crossSystemCount += 1;
    }
    if (route.sideEffect === 'external_write' || route.sideEffect === 'external_send') {
      writeDataScopes.add(route.toolId);
    }
    if (route.sideEffect === 'financial_transaction') {
      hasFinancial = true;
    }
    if (route.sideEffect === 'production_publish' || route.sideEffect === 'external_send') {
      hasIdentity = true;
    }
  }
  const dataAggregation = Math.min(writeDataScopes.size, 3);
  const crossSystem = Math.min(crossSystemCount, 3);
  const financial = hasFinancial ? 4 : 0;
  const identity = hasIdentity ? 2 : 0;

  // 不可逆性: 取最大值
  const irreversibility = Math.max(
    ...toolRoutes.map((route) => {
      const irreversible = new Set([
        'external_send',
        'resource_delete',
        'financial_transaction',
        'production_publish',
      ]);
      return irreversible.has(route.sideEffect) ? Math.max(RISK_LEVEL_VALUE[route.riskBase], 3) : 0;
    }),
  );

  // 重复因子: 总调用次数
  const totalRepetitions = Array.from(repetitionMap.values()).reduce((a, b) => a + b, 0);

  // 累计风险 = base + dataAggregation + crossSystem + financial + identity + repetition/2
  const compensationDiscount = verifiedCompensation ? 1 : 0;
  const cumulativeValue = Math.max(
    maxBase,
    maxBase + dataAggregation + crossSystem + financial + identity + Math.floor(totalRepetitions / 2) - compensationDiscount,
  );

  return {
    schema: 'awkn-risk-snapshot/v1',
    baseActionRisk: valueToRiskLevel(maxBase),
    dataAggregationRisk: valueToRiskLevel(dataAggregation),
    irreversibility: valueToRiskLevel(irreversibility),
    crossSystemPropagation: valueToRiskLevel(crossSystem),
    financialImpact: valueToRiskLevel(financial),
    identityRepresentation: valueToRiskLevel(identity),
    repetitionFactor: totalRepetitions,
    verifiedCompensation,
    cumulativeRisk: valueToRiskLevel(cumulativeValue),
  };
}

/**
 * 判断累计风险是否需要触发额外控制 (设计文档第 8 节)
 *
 * 达到阈值后触发:
 * - 更高授权
 * - 参数摘要
 * - 二次确认
 * - 人工审核
 * - 限制批量数量
 * - 禁止自动重试
 */
export function requiresAdditionalControls(snapshot: RiskSnapshot): boolean {
  // 累计风险达到 R3 或以上需要额外控制
  const cumulativeValue = RISK_LEVEL_VALUE[snapshot.cumulativeRisk];
  return cumulativeValue >= 3;
}

/**
 * 判断是否需要人工审核
 */
export function requiresHumanReview(snapshot: RiskSnapshot): boolean {
  const cumulativeValue = RISK_LEVEL_VALUE[snapshot.cumulativeRisk];
  // R4 及以上需要人工审核; R3 + 不可逆动作也需要
  if (cumulativeValue >= 4) return true;
  if (cumulativeValue >= 3 && RISK_LEVEL_VALUE[snapshot.irreversibility] >= 3) return true;
  if (RISK_LEVEL_VALUE[snapshot.financialImpact] >= 4) return true;
  return false;
}

/**
 * 判断是否需要二次确认
 */
export function requiresSecondaryConfirmation(snapshot: RiskSnapshot): boolean {
  const cumulativeValue = RISK_LEVEL_VALUE[snapshot.cumulativeRisk];
  return cumulativeValue >= 3;
}

/**
 * 判断是否禁止自动重试
 */
export function forbidsAutomaticRetry(snapshot: RiskSnapshot): boolean {
  const cumulativeValue = RISK_LEVEL_VALUE[snapshot.cumulativeRisk];
  // 不可逆动作 + 累计风险 R3+ 禁止自动重试
  if (cumulativeValue >= 3 && RISK_LEVEL_VALUE[snapshot.irreversibility] >= 3) return true;
  return cumulativeValue >= 4;
}
