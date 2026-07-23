/**
 * PRD 一致性评估算法
 *
 * 算法思路：
 * 1. 从 PRD 抽取"关键需求项"（用户故事 US-xxx + 验收标准 AC-xxx），每项算一个 hash
 * 2. 从当前产出（执行计划 + 工程文档）抽取"已覆盖项"，每项算一个 hash
 * 3. 一致性 = |交集| / |PRD关键需求|
 * 4. < 0.8 → 打回，输出未覆盖清单
 *
 * 匹配策略：hash 精确匹配 OR 需求 ID 出现在产出中（ID 是结构化标记，LLM 必须明确引用才算覆盖）
 *
 * 设计取舍（2026-07-23 修订）：
 * - 历史版本曾用"需求文本前 20 字符出现"作为策略 3 兜底，但实测会导致 LLM 复述 PRD
 *   即可让 consistency=1.0，使算法退化为"自评自满"，违反 Loop Engineering 铁律 2
 * - 现移除策略 3，强制 LLM 在产出中明确写出 ID 才算覆盖，避免假达成
 */

import { createHash } from 'node:crypto';

export interface PrdRequirement {
  /** 需求 ID（US-001 / AC-002 / REQ-n） */
  id: string;
  /** 需求原文 */
  text: string;
  /** text 的 sha256 hash（前 16 字符） */
  hash: string;
  /** 是否在产出中找到对应 */
  covered: boolean;
  /** 覆盖证据（产出中匹配到的片段） */
  coverageProof?: string;
}

export interface PrdConsistencyResult {
  /** 一致性分数 0..1 */
  consistency: number;
  /** 是否通过（consistency >= 0.8） */
  passed: boolean;
  /** 未覆盖清单，回填给下轮 */
  uncovered: PrdRequirement[];
  /** 已覆盖清单 */
  covered: PrdRequirement[];
}

/** sha256 hash（取前 16 字符，够用且省内存） */
function hash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

/**
 * 从 PRD 文本中抽取关键需求项
 * 匹配格式：US-xxx: ... / AC-xxx: ... / 验收标准: ...
 */
export function extractRequirements(prd: string): PrdRequirement[] {
  const reqs: PrdRequirement[] = [];
  const patterns: Array<{ re: RegExp; type: 'US' | 'AC' | 'GENERIC' }> = [
    { re: /(?:^|\n)(US-\d+)\s*[:：]\s*(.+)/g, type: 'US' },
    { re: /(?:^|\n)(AC-\d+)\s*[:：]\s*(.+)/g, type: 'AC' },
    { re: /(?:^|\n)验收标准\s*[:：]\s*(.+)/g, type: 'GENERIC' },
  ];

  for (const { re } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(prd)) !== null) {
      // m[1] 可能是 ID（US-xxx/AC-xxx）也可能是空字符串（GENERIC pattern 的空捕获组）
      // 仅当 m[1] 符合 ID 格式时使用，否则 fallback 到 REQ-n
      const capturedId = m[1] ?? '';
      const id = /^(US|AC)-\d+$/.test(capturedId)
        ? capturedId
        : `REQ-${reqs.length + 1}`;
      const text = (m[2] ?? m[1] ?? '').trim();
      if (!text) continue;
      // 去重（同 ID 不重复加）
      if (reqs.some((r) => r.id === id)) continue;
      reqs.push({ id, text, hash: hash(text), covered: false });
    }
  }

  return reqs;
}

/**
 * 评估 PRD 一致性
 *
 * @param prd PRD 文本
 * @param artifacts 产出文本数组（执行计划、工程文档等）
 * @returns 一致性结果
 */
export function evaluatePrdConsistency(prd: string, artifacts: string[]): PrdConsistencyResult {
  const prdReqs = extractRequirements(prd);

  // 空需求时，默认一致（无需求可不一致）
  if (prdReqs.length === 0) {
    return { consistency: 1, passed: true, uncovered: [], covered: [] };
  }

  // 构建产出 hash 集合
  const artifactHashes = new Set<string>();
  for (const a of artifacts) {
    for (const line of a.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        artifactHashes.add(hash(trimmed));
      }
    }
  }

  const uncovered: PrdRequirement[] = [];
  const covered: PrdRequirement[] = [];

  for (const req of prdReqs) {
    // 匹配策略 1: hash 精确匹配
    if (artifactHashes.has(req.hash)) {
      req.covered = true;
      req.coverageProof = 'hash exact match';
      covered.push(req);
      continue;
    }

    // 匹配策略 2: 需求 ID 出现在产出中（LLM 必须在 plan/docs 里明确引用 US-xxx/AC-xxx 才算覆盖）
    const idMatch = artifacts.some((a) => a.includes(req.id));
    if (idMatch) {
      req.covered = true;
      req.coverageProof = `${req.id} found in artifacts`;
      covered.push(req);
      continue;
    }

    // 未覆盖（已移除策略 3"文本前 20 字符出现"匹配，避免 LLM 复述 PRD 即假达成）
    req.covered = false;
    uncovered.push(req);
  }

  const consistency = (prdReqs.length - uncovered.length) / prdReqs.length;
  const passed = consistency >= 0.8;

  return { consistency, passed, uncovered, covered };
}

/**
 * 从 awkn-审核 输出文本中解析审查结论
 * 匹配格式：PASS / PASS_WITH_RISKS / FAIL / 通过 / 不通过
 *
 * 设计变更（2026-07-23）：
 * - 旧版顺序：先判 PASS（含"通过"且不含"不通过"）再判 FAIL
 * - 实测 bug：parseReviewVerdict('不通过，存在 3 个问题') 被识别为 PASS
 *   原因待查（可能 tsx 编译或 regex 引擎差异），但根本性修复是先判 FAIL 再判 PASS
 * - 新版：先匹配 FAIL 关键词（不通过/未通过/拒绝），再匹配 PASS（通过）
 */
export function parseReviewVerdict(text: string): 'PASS' | 'FAIL' | null {
  // 优先匹配英文标记
  const m = text.match(/\b(PASS_WITH_RISKS|PASS|FAIL)\b/i);
  if (m) {
    const v = m[1]!.toUpperCase();
    if (v === 'PASS_WITH_RISKS') return 'PASS'; // 风险通过也算 PASS
    return v as 'PASS' | 'FAIL';
  }
  // 中文匹配 — 先判 FAIL，避免"不通过"被"通过"子串匹配误判
  if (/不通过|未通过|拒绝/.test(text)) return 'FAIL';
  if (/通过/.test(text)) return 'PASS';
  return null;
}
