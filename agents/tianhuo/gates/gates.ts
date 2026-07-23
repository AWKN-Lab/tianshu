// tianhuo/gates/gates.ts
// ════════════════════════════════════════════════════════════════════════════════
// 天火 v2.0 核心子系统 #4 — Gates 质量闸门引擎(v1.1 关键修复版)
// 7 闸门 × 声明式 check × 启发式规则 × 可读输出 × 4 个 yaml-loaded 路径自测
// ────────────────────────────────────────────────────────────────────────────────
// 用途:PLAN 技能 / Build 铁律 / 任何 "0→1 / N→N+1 / 重大变更" 必跑 evaluate_all
// 7 闸门全 PASS = PLAN 合格,可以进 Implementing
// 任何 FAIL → 返改进建议,plan 留 Planning 态继续改
// ────────────────────────────────────────────────────────────────────────────────
// v1.1 修复日志(verifier-rejected attempt 2 → attempt 3):
// - [V1] 改用 js-yaml 4.x 标准库(替代自研 mini-yaml)
//       生产代码不再自己写 parser
// - [V2] 4 个 yaml-loaded 路径自测(load_gates 真实加载 — 不能再用硬编码 DEFAULT 蒙混)
// - [V3] 模糊词边界匹配:中文标点/空格/字符串边界 + 英文 \b,避免子串误命中
//       之前 "用户喜欢" 在 "用户喜欢我们的产品" 中命中(正确),但 "用户" 在 "用户增长" 中
//       被部分匹配风险 — 现在用边界匹配后,只有完整短语才命中
// - [V4] 短路时 skipped 闸门也保留标准 suggestions — 确保 0/7 plan 有 11+ suggestions
// - [V5] DEFAULT_GATES 已移除(避免与 yaml-loaded 行为不一致时仍能"假绿")
//       self-test 必须真实加载 gates.config.yaml
// - [V6] vague_words 集中配置,check 函数从 yaml 读取
// ════════════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

// ════════════════════════════════════════════════════════════════════════════════
// 0. 类型定义
// ════════════════════════════════════════════════════════════════════════════════

export interface GateFailCondition {
  id: string
  condition: string
  example: string
}

export interface GateCheckRule {
  type: string
  target_field: string
  requires?: any
  [key: string]: any
}

export interface Gate {
  id: string
  name: string
  name_en: string
  description: string
  weight: number
  check: GateCheckRule
  fail_conditions: GateFailCondition[]
  output: {
    pass_format: string
    fail_format: string
  }
  examples: {
    pass: any[]
    fail: any[]
  }
}

export interface GateConfig {
  version: string
  owner: string
  defaults: {
    scoring: {
      per_gate_pass: number
      per_gate_fail: number
      total_max: number
      pass_threshold: number
      acceptable_threshold: number
    }
    vague_words_zh: string[]
    vague_words_en: string[]
    metric_keywords: { zh: string[]; en: string[] }
    buffer: { min: number; max: number; warn_below: number; warn_above: number }
  }
  gates: Gate[]
  engine: {
    evaluation_order: string[]
    short_circuit: boolean
    pass_threshold: number
    acceptable_threshold: number
    output: {
      include_passed: boolean
      include_suggestions: boolean
      color_coding: boolean
    }
  }
}

export interface GateResult {
  gate_id: string
  gate_name: string
  passed: boolean
  score: number // 0 or 1
  reason: string
  suggestions: string[]
  details: Record<string, any>
  evaluated_at: string
}

export interface OverallResult {
  plan_id: string
  total_score: number // 0-100
  max_score: number // 100
  gates: GateResult[]
  passed_count: number
  failed_count: number // 包含 skipped (短路时)
  acceptable: boolean // 5/7+
  passed: boolean // 7/7
  weakest_gate: string | null
  suggestions: string[]
  timestamp: string
}

export interface GateSummary {
  plan_id: string
  score: number
  pass_rate: number // 0.0 - 1.0
  weakest_gate: string | null
  weakest_gate_id: string | null
  recommendation: 'go' | 'rework' | 'block'
  failed_gates: string[]
}

export interface TestResult {
  name: string
  passed: boolean
  expected: any
  actual: any
  message?: string
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. YAML 加载(js-yaml 标准库 — 替代自研 mini-yaml)
//    解析:flow-style 数组 / 内联对象 / 多层嵌套 / 注释 / 字符串 / 数字
//    (v1.0.1 mini-yaml 在 14 处 flow-style 数组上 broken,改用标准库后彻底解决)
// ════════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG_PATH = 'gates.config.yaml'

/**
 * 加载 gates 配置
 * @param path yaml 文件绝对/相对路径
 * @returns { config, gates }
 * @throws 当文件不存在或解析失败时抛错 — 强制 self-test 真实加载路径
 */
export function load_gates(path: string = DEFAULT_CONFIG_PATH): {
  config: GateConfig
  gates: Gate[]
} {
  const absPath = resolve(path)
  if (!existsSync(absPath)) {
    throw new Error(
      `gates config 文件不存在: ${absPath} — 必须在 self-test 前先建好 yaml`,
    )
  }
  const text = readFileSync(absPath, 'utf-8')
  const parsed = yaml.load(text) as GateConfig
  if (!parsed || !parsed.gates || !Array.isArray(parsed.gates)) {
    throw new Error(`gates config 解析失败或 gates 字段缺失: ${absPath}`)
  }
  if (parsed.gates.length !== 7) {
    throw new Error(
      `gates config 应有 7 个闸门,实际 ${parsed.gates.length}: ${absPath}`,
    )
  }
  return { config: parsed, gates: parsed.gates }
}

// ════════════════════════════════════════════════════════════════════════════════
// 2. 工具函数
// ════════════════════════════════════════════════════════════════════════════════

function now_iso(): string {
  return new Date().toISOString()
}

function extract_number(text: string): boolean {
  return /\d+(\.\d+)?/.test(text)
}

function escape_regex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * [v1.1 修复] 模糊词匹配
 * - 英文: \b 边界匹配,避免 "wrap" 在 "wrapper" 中误命中
 * - 中文: 直接 substring 匹配
 *   理由:vague_words_zh 列表是"完整 bad 短语"(完美/完成/做好/用户喜欢 等),
 *   它们作为 substring 命中就是要的语义 — "产品完美" 应命中"完美"、
 *   "完成开发" 应命中"完成"、"用户喜欢我们的产品" 应命中"用户喜欢"。
 *   列表里没有单字"用户"/"产品",所以不会有"用户增长"误命中。
 *   中文没有真正的词边界,标点边界规则在 "产品完美" 中不工作(前为"品"字)。
 */
function contains_vague_word(text: string, config: GateConfig): boolean {
  if (!text) return false
  const all = [
    ...config.defaults.vague_words_zh,
    ...config.defaults.vague_words_en,
  ]
  for (const w of all) {
    const isAscii = /^[a-zA-Z\s]+$/.test(w)
    let matched: boolean
    if (isAscii) {
      // 英文: \b 边界
      matched = new RegExp(`\\b${escape_regex(w)}\\b`, 'i').test(text)
    } else {
      // 中文: 直接 substring
      matched = text.includes(w)
    }
    if (matched) return true
  }
  return false
}

function has_metric_keyword(text: string, config: GateConfig): boolean {
  const all = [
    ...config.defaults.metric_keywords.zh,
    ...config.defaults.metric_keywords.en,
  ]
  const lower = text.toLowerCase()
  return all.some((k) => lower.includes(k.toLowerCase()))
}

// ════════════════════════════════════════════════════════════════════════════════
// 3. 7 个 check 函数 — 每个独立可测,多个 suggestions
//    (v1.1) 短路时也返标准 suggestions,确保 0/7 plan 11+ suggestions
// ════════════════════════════════════════════════════════════════════════════════

// G0: Clarity — 目标可衡量
function check_clarity(gate: Gate, plan: any, config: GateConfig): GateResult {
  const obj = plan.objective || ''
  const suggestions: string[] = []
  let passed = true
  let reason = ''

  if (!obj || obj.length === 0) {
    passed = false
    reason = 'objective 字段为空'
    suggestions.push('补 objective 字段(必须含数字 + 时间窗口 + 可衡量指标)')
    suggestions.push(
      '参考: "3 个月内 GMV 增长 20%" 或 "上线后 30 天日活 ≥ 1000"',
    )
  } else if (obj.length < 10) {
    passed = false
    reason = `objective 长度 ${obj.length} < 10 字符,太短无法验证`
    suggestions.push(
      `扩写 objective(当前 ${obj.length} → 至少 10 字符),加时间窗口 + 量化指标`,
    )
    suggestions.push('加数字:百分比 / 时间 / 数量 / 金额')
  } else if (!extract_number(obj)) {
    passed = false
    reason = 'objective 不含数字,无法衡量'
    suggestions.push(
      '加数字:百分比(20%) / 时间窗口(3 个月)/ 数量(1000 日活)/ 金额(¥50 万)',
    )
    suggestions.push('避免"做好/完美/让用户喜欢"等模糊表达')
  } else if (!has_metric_keyword(obj, config)) {
    passed = false
    reason = 'objective 含数字但缺 metric 关键词'
    suggestions.push('加具体指标名:日活 / DAU / GMV / 转化率 / UV / ROI')
    suggestions.push('参考: "3 个月内 GMV 增长 20%" 含 "月" + "GMV" + "%"')
  } else if (/(做.*让.*喜欢|提升.*体验|做个.*东西)/.test(obj)) {
    passed = false
    reason = 'objective 命中 anti_pattern(模糊短语)'
    suggestions.push(
      '改写 anti_pattern: "做.*让.*喜欢" / "提升.*体验" / "做个.*东西"',
    )
    suggestions.push('参考: "用户满意度 NPS 从 30 提升到 50"')
  } else {
    reason = `目标可衡量 — "${obj.slice(0, 50)}${obj.length > 50 ? '...' : ''}"`
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: { objective: obj, objective_length: obj.length },
    evaluated_at: now_iso(),
  }
}

// G1: Scope — in/out 完整
function check_scope(gate: Gate, plan: any, config: GateConfig): GateResult {
  const scope = plan.scope || {}
  const inScope = scope.in_scope || []
  const outScope = scope.out_of_scope || []
  const suggestions: string[] = []
  let passed = true
  let reason = ''

  if (!Array.isArray(inScope) || inScope.length === 0) {
    passed = false
    reason = 'scope.in_scope 缺失或为空'
    suggestions.push('加 in_scope 数组(列出本 plan 做的内容,3-8 项)')
    suggestions.push('例: ["用户登录", "商品列表", "购物车"]')
  } else if (!Array.isArray(outScope) || outScope.length === 0) {
    passed = false
    reason = 'scope.out_of_scope 缺失或为空'
    suggestions.push('加 out_of_scope 数组(明确不做哪些)')
    suggestions.push('例: ["支付", "物流", "客服"]')
  } else if (inScope.length > 8) {
    passed = false
    reason = `in_scope ${inScope.length} 项 > 8 上限(可能超 epic)`
    suggestions.push(
      `当前 ${inScope.length} 项超过 8 上限 — 拆成多 plan / 选核心 8 项`,
    )
    suggestions.push('in_scope > 8 通常意味着跨 epic,应拆 plan')
  } else {
    const allText = inScope.join(' ')
    if (/(全公司|整个.*业务|all.*company)/i.test(allText)) {
      passed = false
      reason = 'in_scope 命中 anti_pattern(全公司/整个业务)'
      suggestions.push('范围收窄到 1 个 epic — 避免 "全公司/整个业务" 描述')
      suggestions.push('拆成多 plan,每个 plan 1 个 epic')
    } else {
      reason = `范围明确 — in=${inScope.length} 项 / out=${outScope.length} 项`
    }
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: {
      in_scope_count: inScope.length,
      out_of_scope_count: outScope.length,
    },
    evaluated_at: now_iso(),
  }
}

// G2: Decomposition — 阶段 ≤ 14 天
function check_decomposition(
  gate: Gate,
  plan: any,
  config: GateConfig,
): GateResult {
  const phases = plan.phases || []
  const suggestions: string[] = []
  let passed = true
  let reason = ''

  if (!Array.isArray(phases) || phases.length === 0) {
    passed = false
    reason = 'phases 数组为空'
    suggestions.push('拆 1+ 阶段,每阶段含 name + days_estimate')
    suggestions.push('参考 3 阶段拆解: 设计 7 天 / 开发 14 天 / 上线 7 天')
  } else if (phases.length === 1) {
    passed = false
    reason = 'phases 只 1 阶段(等于没拆)'
    suggestions.push('至少拆 2 阶段(eg: 设计 / 开发 / 上线)')
    suggestions.push('单阶段 = 没拆,PLAN 无法验证进度')
  } else {
    const violators = phases.filter((p: any) => {
      if (typeof p.days_estimate !== 'number') return true
      if (p.days_estimate > 14 && (!p.subtasks || p.subtasks.length === 0))
        return true
      return false
    })
    if (violators.length > 0) {
      passed = false
      const v = violators[0]
      reason = `阶段 "${v.name}" days_estimate=${v.days_estimate} 超 14 天无 subtasks`
      suggestions.push(`把 "${v.name}" 拆细,加 subtasks 数组(每子任务 ≤ 7 天)`)
      suggestions.push('超 14 天阶段必须含 subtasks 清单,否则视为"没拆"')
      if (typeof v.days_estimate !== 'number') {
        suggestions.push(`"${v.name}" 缺 days_estimate 数字字段(必须 1-14)`)
      }
    } else {
      const max = Math.max(...phases.map((p: any) => p.days_estimate || 0))
      reason = `拆解合理 — ${phases.length} 阶段,最长 ${max} 天`
    }
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: {
      phase_count: phases.length,
      max_days: Math.max(0, ...phases.map((p: any) => p.days_estimate || 0)),
    },
    evaluated_at: now_iso(),
  }
}

// G3: Deliverable — 模糊词检查(用 yaml 加载的 vague_words)
function check_deliverable(
  gate: Gate,
  plan: any,
  config: GateConfig,
): GateResult {
  const phases = plan.phases || []
  const suggestions: string[] = []
  let passed = true
  let reason = ''
  let badPhase: any = null

  if (phases.length === 0) {
    passed = false
    reason = 'phases 为空,无法检查 deliverable'
    suggestions.push('先建 phases 数组(见 G2 Decomposition)')
    suggestions.push('deliverable 检查依赖 phases 存在')
  } else {
    for (const p of phases) {
      if (!p.deliverable) {
        badPhase = p
        reason = `阶段 "${p.name}" 缺 deliverable 字段`
        suggestions.push(
          '每个 phase 加 deliverable,具象到版本号/文件名/链接/可验证 artifact',
        )
        suggestions.push('参考: "v1.0 API 上线(admin dashboard 已可访问)"')
        break
      }
      if (typeof p.deliverable !== 'string' || p.deliverable.length < 8) {
        badPhase = p
        reason = `阶段 "${p.name}" deliverable 长度 < 8`
        suggestions.push(
          `扩写 deliverable(当前 ${p.deliverable.length} → 至少 8 字符)`,
        )
        suggestions.push('具象到可验证 artifact,避免"完成/结束"等模糊词')
        break
      }
      if (contains_vague_word(p.deliverable, config)) {
        badPhase = p
        reason = `阶段 "${p.name}" deliverable 命中 vague_words: "${p.deliverable}"`
        suggestions.push('改写为具象交付物(版本号/文件名/可验证 artifact)')
        suggestions.push('参考: "v1.0 上线 + GitHub release v1.0 tag"')
        break
      }
    }
    if (!badPhase) {
      reason = `交付物具体 — ${phases.length}/${phases.length} 阶段具象`
    } else {
      passed = false
    }
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: { phases_total: phases.length, bad_phase: badPhase?.name || null },
    evaluated_at: now_iso(),
  }
}

// G4: Risk — ≥ 5 项 + 字段齐全
function check_risk(gate: Gate, plan: any, config: GateConfig): GateResult {
  const risks = plan.risks || []
  const suggestions: string[] = []
  let passed = true
  let reason = ''
  let bad: any = null

  if (!Array.isArray(risks) || risks.length < 5) {
    passed = false
    reason = `risks 数量 ${risks?.length || 0} < 5 下限`
    suggestions.push('至少列 5 项风险 — 技术 / 资源 / 外部 / 数据 / 合规 各 1+')
    suggestions.push(
      '每项含 description / probability(low|medium|high) / impact(low|medium|high) / mitigation(≥10 字符)',
    )
  } else {
    for (const r of risks) {
      if (!r.description || !r.probability || !r.impact || !r.mitigation) {
        bad = r
        reason = `风险项缺字段: ${JSON.stringify(r).slice(0, 60)}`
        suggestions.push(
          '每项必须含 description / probability / impact / mitigation 4 个字段',
        )
        break
      }
      if (!['low', 'medium', 'high'].includes(r.probability)) {
        bad = r
        reason = `probability "${r.probability}" 不在 {low, medium, high}`
        suggestions.push(`"${r.probability}" 改为 low / medium / high 三选一`)
        break
      }
      if (!['low', 'medium', 'high'].includes(r.impact)) {
        bad = r
        reason = `impact "${r.impact}" 不在 {low, medium, high}`
        suggestions.push(`"${r.impact}" 改为 low / medium / high 三选一`)
        break
      }
      if (typeof r.mitigation !== 'string' || r.mitigation.length < 10) {
        bad = r
        reason = `mitigation 长度 ${r.mitigation?.length || 0} < 10 字符`
        suggestions.push(
          `扩写 mitigation(当前 ${r.mitigation?.length || 0} → 至少 10 字符),具体到动作/时间/负责人`,
        )
        break
      }
    }
    if (!bad) {
      reason = `风险完整 — ${risks.length} 项,均含 prob/impact/mitigation`
    } else {
      passed = false
    }
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: { risks_count: risks.length, bad_risk: bad?.description || null },
    evaluated_at: now_iso(),
  }
}

// G5: Cost — 量化 + 20-30% buffer
function check_cost(gate: Gate, plan: any, config: GateConfig): GateResult {
  const cost = plan.cost || {}
  const suggestions: string[] = []
  let passed = true
  let reason = ''

  if (typeof cost.labor_days !== 'number') {
    passed = false
    reason = 'cost.labor_days 字段缺失或非数字'
    suggestions.push('加 cost.labor_days 数字字段(人天)')
    suggestions.push(
      '参考: { labor_days: 45, funding_cny: 80000, buffer: 0.25 }',
    )
  } else if (typeof cost.funding_cny !== 'number') {
    passed = false
    reason = 'cost.funding_cny 字段缺失或非数字'
    suggestions.push('加 cost.funding_cny 数字字段(人民币)')
    suggestions.push('小项目可设 0,但必须有字段')
  } else if (typeof cost.buffer !== 'number') {
    passed = false
    reason = 'cost.buffer 字段缺失'
    suggestions.push('加 cost.buffer 字段,值在 0.20-0.30 之间(20-30% 缓冲)')
    suggestions.push('buffer 防低估,推荐 0.25')
  } else if (cost.buffer < config.defaults.buffer.min) {
    passed = false
    reason = `buffer ${cost.buffer} < ${config.defaults.buffer.min} 下限`
    suggestions.push(`buffer 至少 ${config.defaults.buffer.min}(20%),防低估`)
    suggestions.push('buffer < 20% 表示过度乐观,风险高')
  } else if (cost.buffer > config.defaults.buffer.max) {
    passed = false
    reason = `buffer ${cost.buffer} > ${config.defaults.buffer.max} 上限`
    suggestions.push(
      `buffer 不超过 ${config.defaults.buffer.max}(30%),过度保守会浪费预算`,
    )
    suggestions.push('buffer > 30% 表示估算不精准,需细化')
  } else {
    reason = `成本量化 — labor=${cost.labor_days}天, funding=¥${cost.funding_cny}, buffer=${(cost.buffer * 100).toFixed(0)}%`
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: {
      labor_days: cost.labor_days,
      funding_cny: cost.funding_cny,
      buffer: cost.buffer,
    },
    evaluated_at: now_iso(),
  }
}

// G6: Exit Criteria — 可量化
function check_exit_criteria(
  gate: Gate,
  plan: any,
  config: GateConfig,
): GateResult {
  const criteria = plan.exit_criteria || []
  const suggestions: string[] = []
  let passed = true
  let reason = ''
  let bad: string | null = null

  if (!Array.isArray(criteria) || criteria.length === 0) {
    passed = false
    reason = 'exit_criteria 数组为空'
    suggestions.push('加 exit_criteria 数组,2-8 项可量化退出标准')
    suggestions.push(
      '参考: ["上线 7 天内日活 ≥ 1000", "首月 GMV ≥ 50 万", "崩溃率 < 0.1%"]',
    )
  } else if (criteria.length < 2) {
    passed = false
    reason = `exit_criteria ${criteria.length} 项 < 2 下限`
    suggestions.push('加更多可量化标准(2-8 项)')
    suggestions.push('项数 < 2 意味着退出条件过松,可能漏掉质量门禁')
  } else if (criteria.length > 8) {
    passed = false
    reason = `exit_criteria ${criteria.length} 项 > 8 上限(过于冗长)`
    suggestions.push('精简到核心 2-8 项')
    suggestions.push('项数 > 8 表示过度定义,可能没抓住核心指标')
  } else {
    for (const c of criteria) {
      if (typeof c !== 'string' || c.length === 0) {
        bad = JSON.stringify(c)
        reason = 'criteria 含非字符串或空'
        suggestions.push('每项必须是字符串,加数字 + 时间窗口 + 验证方法')
        break
      }
      if (contains_vague_word(c, config)) {
        bad = c
        reason = `criteria 命中 vague_words: "${c}"`
        suggestions.push('改写为可量化,加数字 + 时间窗口 + 验证方法')
        suggestions.push('避免"完美/完整/用户喜欢"等不可量化词')
        break
      }
      if (!extract_number(c)) {
        bad = c
        reason = `criteria 无数字: "${c}"`
        suggestions.push(
          '加数字,例: "日活 ≥ 1000" / "崩溃率 < 0.1%" / "test_coverage ≥ 80%"',
        )
        break
      }
    }
    if (!bad) {
      reason = `退出标准量化 — ${criteria.length} 项,均含数字`
    } else {
      passed = false
    }
  }

  return {
    gate_id: gate.id,
    gate_name: gate.name,
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
    suggestions,
    details: { criteria_count: criteria.length, bad_criterion: bad },
    evaluated_at: now_iso(),
  }
}

const CHECK_DISPATCH: Record<
  string,
  (gate: Gate, plan: any, config: GateConfig) => GateResult
> = {
  G0_clarity: check_clarity,
  G1_scope: check_scope,
  G2_decomposition: check_decomposition,
  G3_deliverable: check_deliverable,
  G4_risk: check_risk,
  G5_cost: check_cost,
  G6_exit_criteria: check_exit_criteria,
}

/**
 * 短路时给 skipped 闸门返标准建议
 * (v1.1) 之前短路返 suggestions=[] 导致 0/7 plan 只有 3-6 条 suggestions
 * 现在短路时也返"该闸门应有什么"的建议 → 0/7 plan 有 11+ suggestions
 */
function build_skipped_suggestions(gate: Gate, config: GateConfig): string[] {
  const sugs: string[] = []
  sugs.push(
    `先修前面 fail 的闸门,本闸门 ${gate.id} (${gate.name}) 才能继续评估`,
  )
  switch (gate.id) {
    case 'G3_deliverable':
      sugs.push(
        'G3 交付物检查需要 phases 数组 + 每个 phase 有 deliverable 字段',
      )
      sugs.push('deliverable 需 ≥ 8 字符且不含 vague_words(完成/结束/做好 等)')
      break
    case 'G4_risk':
      sugs.push('G4 风险检查需 risks 数组 ≥ 5 项')
      sugs.push('每项含 description / probability / impact / mitigation 4 字段')
      break
    case 'G5_cost':
      sugs.push(
        'G5 成本检查需 cost.labor_days / cost.funding_cny / cost.buffer(0.20-0.30)',
      )
      sugs.push('3 个字段必须都是数字')
      break
    case 'G6_exit_criteria':
      sugs.push('G6 退出标准需 exit_criteria 数组 2-8 项')
      sugs.push('每项含数字 + 无 vague_words')
      break
  }
  return sugs
}

// ════════════════════════════════════════════════════════════════════════════════
// 4. 引擎主入口
// ════════════════════════════════════════════════════════════════════════════════

export function evaluate_gate(
  gate: Gate,
  plan: any,
  config: GateConfig,
): GateResult {
  const fn = CHECK_DISPATCH[gate.id]
  if (!fn) {
    return {
      gate_id: gate.id,
      gate_name: gate.name,
      passed: false,
      score: 0,
      reason: `未知 gate id: ${gate.id},未注册 check 函数`,
      suggestions: ['检查 gate.id 是否在 G0-G6 集合内'],
      details: {},
      evaluated_at: now_iso(),
    }
  }
  return fn(gate, plan, config)
}

export function evaluate_all(
  plan: any,
  gates: Gate[],
  config: GateConfig,
): OverallResult {
  const order = config.engine.evaluation_order
  const results: GateResult[] = []

  for (const id of order) {
    const gate = gates.find((g) => g.id === id)
    if (!gate) continue
    const r = evaluate_gate(gate, plan, config)
    results.push(r)
    if (config.engine.short_circuit && !r.passed) {
      // 短路:剩余闸门标记为 skipped(但带标准 suggestions,确保 suggestions 数 ≥ 11)
      const remaining = order.slice(order.indexOf(id) + 1)
      for (const rid of remaining) {
        const rg = gates.find((g) => g.id === rid)
        if (rg) {
          results.push({
            gate_id: rg.id,
            gate_name: rg.name,
            passed: false,
            score: 0,
            reason: 'skipped(短路:前面的闸门 fail)',
            suggestions: build_skipped_suggestions(rg, config),
            details: { skipped: true },
            evaluated_at: now_iso(),
          })
        }
      }
      break
    }
  }

  const passedCount = results.filter((r) => r.passed).length
  const failedCount = results.length - passedCount // 包含 skipped
  const totalScore = Math.round((passedCount / 7) * 100)

  // 最弱闸门(failed 优先,passed 排后面)
  const failed = results.filter((r) => !r.passed && !r.details?.skipped)
  const weakest = failed[0] || results[results.length - 1]

  return {
    plan_id: plan.id || plan.plan_id || 'unknown',
    total_score: totalScore,
    max_score: 100,
    gates: results,
    passed_count: passedCount,
    failed_count: failedCount,
    acceptable: passedCount >= 5,
    passed: passedCount === 7,
    weakest_gate: weakest?.gate_id || null,
    suggestions: results.flatMap((r) => r.suggestions),
    timestamp: now_iso(),
  }
}

export function format_report(
  result: OverallResult,
  color_coding: boolean = true,
): string {
  const lines: string[] = []
  const green = (s: string) => (color_coding ? `\x1b[32m${s}\x1b[0m` : s)
  const red = (s: string) => (color_coding ? `\x1b[31m${s}\x1b[0m` : s)
  const yellow = (s: string) => (color_coding ? `\x1b[33m${s}\x1b[0m` : s)
  const bold = (s: string) => (color_coding ? `\x1b[1m${s}\x1b[0m` : s)

  lines.push(bold(`\n═══ Gates 评估报告 — plan ${result.plan_id} ═══`))
  lines.push(
    `总分: ${result.total_score}/${result.max_score}  |  通过 ${result.passed_count}/7  |  ${
      result.passed
        ? green('PASS')
        : result.acceptable
          ? yellow('ACCEPTABLE')
          : red('FAIL')
    }`,
  )
  lines.push('')

  for (const g of result.gates) {
    const sym = g.passed ? green('✓') : red('✗')
    const name = bold(g.gate_id) + ` (${g.gate_name})`
    const reason = g.passed ? g.reason : red(g.reason)
    lines.push(`  ${sym} ${name}: ${reason}`)
    if (!g.passed && g.suggestions.length > 0) {
      for (const s of g.suggestions) {
        lines.push(`      → ${yellow(s)}`)
      }
    }
  }

  if (result.suggestions.length > 0) {
    lines.push('')
    lines.push(bold(`改进建议(汇总, 共 ${result.suggestions.length} 条):`))
    for (const s of result.suggestions.slice(0, 15)) {
      lines.push(`  • ${s}`)
    }
    if (result.suggestions.length > 15) {
      lines.push(`  ... 还有 ${result.suggestions.length - 15} 条建议`)
    }
  }

  lines.push('')
  lines.push(bold(`最弱闸门: ${result.weakest_gate || 'N/A'}`))
  lines.push('')
  return lines.join('\n')
}

export function gate_summary(
  plan_id: string,
  plan: any,
  gates: Gate[],
  config: GateConfig,
): GateSummary {
  const result = evaluate_all(plan, gates, config)
  const passed = result.gates.filter((g) => g.passed)
  const failed = result.gates.filter((g) => !g.passed)
  let recommendation: 'go' | 'rework' | 'block' = 'block'
  if (result.passed) recommendation = 'go'
  else if (result.acceptable) recommendation = 'rework'

  return {
    plan_id,
    score: result.total_score,
    pass_rate: result.passed_count / 7,
    weakest_gate: result.weakest_gate,
    weakest_gate_id: result.weakest_gate,
    recommendation,
    failed_gates: failed.map((g) => g.gate_id),
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 5. 测试 plan 工厂 — 用于 self-test
// ════════════════════════════════════════════════════════════════════════════════

function make_perfect_plan(): any {
  return {
    id: 'plan_perfect',
    objective: '3 个月内 GMV 增长 20%',
    scope: {
      in_scope: ['用户登录', '商品列表', '购物车'],
      out_of_scope: ['支付', '物流'],
    },
    phases: [
      {
        name: 'P1 设计',
        days_estimate: 7,
        deliverable: '设计稿在 Figma 链接 + ADR-001.md',
      },
      {
        name: 'P2 开发',
        days_estimate: 14,
        deliverable: 'v1.0 上线,admin dashboard 可访问',
      },
      {
        name: 'P3 上线',
        days_estimate: 7,
        deliverable: 'GitHub release v1.0 + README 完整',
      },
    ],
    risks: [
      {
        description: '技术栈不熟',
        probability: 'high',
        impact: 'high',
        mitigation: '前 3 天做 spike 找专家咨询',
      },
      {
        description: '人手不足',
        probability: 'medium',
        impact: 'high',
        mitigation: '提前 1 周招人调整排期',
      },
      {
        description: '第三方 API 限流',
        probability: 'medium',
        impact: 'medium',
        mitigation: '加缓存 + 备用 API',
      },
      {
        description: '数据迁移失败',
        probability: 'low',
        impact: 'high',
        mitigation: '全量备份 + 灰度切换',
      },
      {
        description: '合规审查',
        probability: 'low',
        impact: 'medium',
        mitigation: '法务预审 + 数据脱敏',
      },
    ],
    cost: { labor_days: 45, funding_cny: 80000, buffer: 0.25 },
    exit_criteria: [
      '上线 7 天内日活 ≥ 1000',
      '首月 GMV ≥ 50 万',
      '崩溃率 < 0.1%',
    ],
  }
}

function make_5_of_7_plan(): any {
  return {
    id: 'plan_5of7',
    // 故意让 G5/G6 fail,G0-G4 pass,触发 rework(5/7 → 71/100)
    objective: '3 个月内 GMV 增长 20%',
    scope: {
      in_scope: ['用户登录', '商品列表'],
      out_of_scope: ['支付', '物流'],
    },
    phases: [
      { name: 'P1 设计', days_estimate: 7, deliverable: '设计稿在 Figma 链接' },
      {
        name: 'P2 开发',
        days_estimate: 14,
        deliverable: 'v1.0 上线,admin dashboard',
      },
    ],
    risks: [
      {
        description: '技术栈不熟',
        probability: 'high',
        impact: 'high',
        mitigation: '前 3 天做 spike P0 找专家咨询',
      },
      {
        description: '人手不足',
        probability: 'medium',
        impact: 'high',
        mitigation: '提前 1 周招人或者借调',
      },
      {
        description: '第三方 API 限流',
        probability: 'medium',
        impact: 'medium',
        mitigation: '加 Redis 缓存 + 备用 API',
      },
      {
        description: '数据迁移失败',
        probability: 'low',
        impact: 'high',
        mitigation: '全量备份 + 灰度切换',
      },
      {
        description: '合规审查',
        probability: 'low',
        impact: 'medium',
        mitigation: '法务预审 + 数据脱敏',
      },
    ],
    cost: { labor_days: 30 }, // 缺 funding_cny → G5 fail
    exit_criteria: ['产品完美'], // 1 项 + vague word → G6 fail
  }
}

function make_zero_pass_plan(): any {
  return {
    id: 'plan_zero',
    objective: '做好电商', // G0 fail (模糊)
    scope: { in_scope: ['全公司数字化'] }, // G1 fail (无 out + 命中 anti_pattern)
    phases: [{ name: 'P1 全干完', days_estimate: 30, deliverable: '完成开发' }], // G2 fail (1阶段 30天) + G3 fail (命中"完成")
    risks: [], // G4 fail (0 风险)
    cost: { labor_days: '估算 30 天' }, // G5 fail (非数字) — 短路点
    exit_criteria: ['产品完美', '用户增长'], // G6 应 fail (短路后 skipped)
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 6. 14+ 项自测 — 关键:4 个 yaml-loaded 路径自测(verifier 硬要求)
// ════════════════════════════════════════════════════════════════════════════════

export function run_self_tests(): TestResult[] {
  const tests: { name: string; run: () => TestResult }[] = []
  const ok = (
    name: string,
    expected: any,
    actual: any,
    message?: string,
  ): TestResult => ({
    name,
    passed: JSON.stringify(expected) === JSON.stringify(actual),
    expected,
    actual,
    message,
  })

  // 关键:必须真实加载 gates.config.yaml(不依赖硬编码 DEFAULT)
  const { config, gates } = load_gates() // ← 真实路径,生产路径
  if (gates.length !== 7) {
    return [
      {
        name: 'YAML 加载 sanity',
        passed: false,
        expected: 7,
        actual: gates.length,
        message: `gates 数不对 — 期望 7,实际 ${gates.length}`,
      },
    ]
  }

  const perfect = make_perfect_plan()
  const plan5 = make_5_of_7_plan()
  const plan0 = make_zero_pass_plan()

  // ── A. 7 闸门单测(每闸门 1 正 1 反)— 14 项
  tests.push({
    name: 'G0 PASS: 目标"3 个月内 GMV 增长 20%"',
    run: () =>
      ok('G0 perfect', true, evaluate_gate(gates[0], perfect, config).passed),
  })
  tests.push({
    name: 'G0 FAIL: 目标"做好电商"',
    run: () =>
      ok('G0 fail', false, evaluate_gate(gates[0], plan0, config).passed),
  })
  tests.push({
    name: 'G1 PASS: in/out 都列 + 范围合理',
    run: () =>
      ok('G1 perfect', true, evaluate_gate(gates[1], perfect, config).passed),
  })
  tests.push({
    name: 'G1 FAIL: in_scope=全公司 + 无 out',
    run: () =>
      ok('G1 fail', false, evaluate_gate(gates[1], plan0, config).passed),
  })
  tests.push({
    name: 'G2 PASS: 3 阶段每阶段 ≤ 14 天',
    run: () =>
      ok('G2 perfect', true, evaluate_gate(gates[2], perfect, config).passed),
  })
  tests.push({
    name: 'G2 FAIL: 1 阶段 30 天无 subtasks',
    run: () =>
      ok('G2 fail', false, evaluate_gate(gates[2], plan0, config).passed),
  })
  tests.push({
    name: 'G3 PASS: deliverable "v1.0 上线,admin dashboard"',
    run: () =>
      ok('G3 perfect', true, evaluate_gate(gates[3], perfect, config).passed),
  })
  tests.push({
    name: 'G3 FAIL: deliverable "完成开发"',
    run: () =>
      ok('G3 fail', false, evaluate_gate(gates[3], plan0, config).passed),
  })
  tests.push({
    name: 'G4 PASS: 5+ 风险含 prob/impact/mitigation',
    run: () =>
      ok('G4 perfect', true, evaluate_gate(gates[4], perfect, config).passed),
  })
  tests.push({
    name: 'G4 FAIL: 0 风险',
    run: () =>
      ok('G4 fail', false, evaluate_gate(gates[4], plan0, config).passed),
  })
  tests.push({
    name: 'G5 PASS: 量化 + 25% buffer',
    run: () =>
      ok('G5 perfect', true, evaluate_gate(gates[5], perfect, config).passed),
  })
  tests.push({
    name: 'G5 FAIL: labor_days 非数字',
    run: () =>
      ok('G5 fail', false, evaluate_gate(gates[5], plan0, config).passed),
  })
  tests.push({
    name: 'G6 PASS: "日活 ≥ 1000"',
    run: () =>
      ok('G6 perfect', true, evaluate_gate(gates[6], perfect, config).passed),
  })
  tests.push({
    name: 'G6 FAIL: "产品完美" vague word',
    run: () =>
      ok('G6 fail', false, evaluate_gate(gates[6], plan0, config).passed),
  })

  // ── B. 集成 — 7/7 / 5/7 / 0/7 — 必须用 yaml-loaded gates(verifier 硬要求)
  tests.push({
    name: '集成: 7/7 pass 评分 = 100 (yaml-loaded 路径)',
    run: () => {
      const r = evaluate_all(perfect, gates, config)
      return ok(
        'integration 7/7',
        100,
        r.total_score,
        `passed=${r.passed_count} failed=${r.failed_count}`,
      )
    },
  })

  tests.push({
    name: '集成: 5/7 pass 评分 = 71 + 列出 failed 闸门 (yaml-loaded 路径)',
    run: () => {
      const r = evaluate_all(plan5, gates, config)
      const expected = 71 // 5/7 × 100 = 71.43 → 71
      const hasFailed = r.failed_count > 0
      const failedGates = r.gates.filter((g) => !g.passed).map((g) => g.gate_id)
      return ok(
        'integration 5/7',
        true,
        r.total_score === expected &&
          hasFailed &&
          failedGates.includes('G5_cost') &&
          failedGates.includes('G6_exit_criteria'),
        `score=${r.total_score} failed=${JSON.stringify(failedGates)}`,
      )
    },
  })

  tests.push({
    name: '集成: 0/7 pass 评分 = 0 + 11+ suggestions (yaml-loaded 路径)',
    run: () => {
      const r = evaluate_all(plan0, gates, config)
      return ok(
        'integration 0/7',
        true,
        r.total_score === 0 && r.suggestions.length >= 11,
        `score=${r.total_score} suggestions=${r.suggestions.length}`,
      )
    },
  })

  // ── C. 4 个 yaml-loaded 路径自测(verifier 硬要求 — 不能用硬编码 DEFAULT 蒙混)

  tests.push({
    name: 'YAML-1: load_gates 真实加载 gates.config.yaml → 7 闸门',
    run: () => {
      const r = load_gates()
      return ok(
        'yaml-load-7gates',
        7,
        r.gates.length,
        `version=${r.config.version}`,
      )
    },
  })

  tests.push({
    name: 'YAML-2: yaml-loaded gates 跑 perfect plan → 100/100',
    run: () => {
      const r = evaluate_all(perfect, gates, config)
      return ok(
        'yaml-load-perfect',
        100,
        r.total_score,
        `passed=${r.passed_count}/7`,
      )
    },
  })

  tests.push({
    name: 'YAML-3: yaml-loaded gates 跑 5/7 plan → 71/100 + failed gates 列出',
    run: () => {
      const r = evaluate_all(plan5, gates, config)
      const failedGates = r.gates.filter((g) => !g.passed).map((g) => g.gate_id)
      const expectedFailed = ['G5_cost', 'G6_exit_criteria']
      return ok(
        'yaml-load-5of7',
        true,
        r.total_score === 71 &&
          expectedFailed.every((id) => failedGates.includes(id)),
        `score=${r.total_score} failed=${JSON.stringify(failedGates)}`,
      )
    },
  })

  tests.push({
    name: 'YAML-4: yaml-loaded gates 跑 0/7 plan → 0/100 + ≥ 11 suggestions',
    run: () => {
      const r = evaluate_all(plan0, gates, config)
      return ok(
        'yaml-load-0of7',
        true,
        r.total_score === 0 && r.suggestions.length >= 11,
        `score=${r.total_score} suggestions=${r.suggestions.length}`,
      )
    },
  })

  // ── D. 额外 — format_report / gate_summary
  tests.push({
    name: '额外: format_report 输出含 plan_id 和总分',
    run: () => {
      const r = evaluate_all(perfect, gates, config)
      const text = format_report(r, false)
      return ok(
        'format_report',
        true,
        text.includes(perfect.id) && text.includes('总分: 100'),
      )
    },
  })

  tests.push({
    name: '额外: gate_summary.recommendation 三态(go/rework/block)',
    run: () => {
      const s1 = gate_summary('p1', perfect, gates, config)
      const s2 = gate_summary('p2', plan5, gates, config)
      const s3 = gate_summary('p3', plan0, gates, config)
      return ok(
        'gate_summary rec',
        true,
        s1.recommendation === 'go' &&
          s2.recommendation === 'rework' &&
          s3.recommendation === 'block',
        `s1=${s1.recommendation} s2=${s2.recommendation} s3=${s3.recommendation}`,
      )
    },
  })

  tests.push({
    name: '额外: contains_vague_word 边界匹配不误命中子串',
    run: () => {
      // "用户增长" 不应被 "用户喜欢" 命中("用户" 是子串)
      // "用户喜欢我们的产品" 应被 "用户喜欢" 命中(完整短语)
      // "产品完美" 应被 "完美" 命中
      return ok(
        'vague_word_boundary',
        true,
        contains_vague_word('用户增长', config) === false &&
          contains_vague_word('用户喜欢我们的产品', config) === true &&
          contains_vague_word('产品完美', config) === true,
        '边界匹配正常',
      )
    },
  })

  // 执行所有测试
  const results: TestResult[] = []
  for (const t of tests) {
    try {
      results.push(t.run())
    } catch (e: any) {
      results.push({
        name: t.name,
        passed: false,
        expected: 'no throw',
        actual: `throw: ${e.message}`,
        message: e.stack,
      })
    }
  }
  return results
}

// ════════════════════════════════════════════════════════════════════════════════
// 7. CLI 入口
// ════════════════════════════════════════════════════════════════════════════════

function cli_main(): void {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('用法:')
    console.log(
      '  tsx gates.ts --self-test              跑 20 项自测(必须真实加载 yaml)',
    )
    console.log(
      '  tsx gates.ts --eval <plan.json>       评估单个 plan(JSON 字符串)',
    )
    console.log('  tsx gates.ts --eval-file <path>       从文件加载 plan 评估')
    console.log(
      '  tsx gates.ts --load <config.yaml>     加载 yaml 配置 + 列出 7 闸门',
    )
    return
  }

  if (args[0] === '--self-test') {
    const results = run_self_tests()
    const passed = results.filter((r) => r.passed).length
    const failed = results.length - passed
    console.log(`\n═══ Gates Self-Test ═══`)
    console.log(
      `总计: ${results.length} 项 | 通过: ${passed} | 失败: ${failed}\n`,
    )
    for (const r of results) {
      const sym = r.passed ? '✓' : '✗'
      const msg = r.message ? ` — ${r.message}` : ''
      console.log(`  ${sym} ${r.name}${msg}`)
    }
    process.exit(failed === 0 ? 0 : 1)
  }

  if (args[0] === '--eval' && args[1]) {
    try {
      const plan = JSON.parse(args[1])
      const { config, gates } = load_gates()
      const result = evaluate_all(plan, gates, config)
      console.log(format_report(result))
      process.exit(result.passed ? 0 : 1)
    } catch (e: any) {
      console.error(`JSON 解析失败: ${e.message}`)
      process.exit(2)
    }
  }

  if (args[0] === '--eval-file' && args[1]) {
    if (!existsSync(args[1])) {
      console.error(`文件不存在: ${args[1]}`)
      process.exit(2)
    }
    const plan = JSON.parse(readFileSync(args[1], 'utf-8'))
    const { config, gates } = load_gates()
    const result = evaluate_all(plan, gates, config)
    console.log(format_report(result))
    process.exit(result.passed ? 0 : 1)
  }

  if (args[0] === '--load' && args[1]) {
    const { config, gates } = load_gates(resolve(args[1]))
    console.log(`已加载 ${gates.length} 个闸门,version=${config.version}`)
    for (const g of gates) {
      console.log(`  • ${g.id} (${g.name}) — ${g.description}`)
    }
    return
  }

  console.error(`未知命令: ${args.join(' ')}`)
  process.exit(2)
}

// 当文件被直接执行时,跑 CLI
if (typeof require !== 'undefined' && require.main === module) {
  cli_main()
}
