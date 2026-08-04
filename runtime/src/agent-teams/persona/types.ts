/**
 * AgentTeams — 数据契约（M1.1 persona-schema 数据部分 + 梯队分级）
 *
 * 影响层级 [M]：本文件为 C1 人格库的数据契约事实源。
 * 字段对齐吸收自 awkn-agent `src/core/types.ts` PersonaRole（L392-415），
 * 新增引擎侧扩展字段：tier / capabilities / keywords（组队选编用）。
 *
 * 三档分级裁决（方案〇节）：
 *   - tier 1 开发核心（必吸 7）：产品顾问/思辨者/工程师/文档匠/验证官/侦探/调研员
 *   - tier 2 决策增强（可选 3）：决策将军/战略家/分析师
 *   - tier 3 内容创作（暂缓 9）：不入库，persona-picker 永不返回
 */

export interface ThinkingModel {
  /** 思维模型名称（如 反诘法5类 / Pre-mortem） */
  name: string;
  /** 适用时机 */
  when: string;
  /** 触发该模型的关键问题 */
  keyQuestion: string;
}

export interface CollaborationMap {
  /** 上游人格 id（DAG 入边来源） */
  upstream: string[];
  /** 下游人格 id（DAG 出边去向） */
  downstream: string[];
  /** 反馈来源（review-chain 回灌方向） */
  feedbackFrom: string[];
}

export type AgentCategory = 'core' | 'technical' | 'business' | 'functional' | 'creative' | 'general';

/** 人格梯队：1=开发核心必吸；2=决策增强可选；3=内容创作暂缓（不入库） */
export type PersonaTier = 1 | 2 | 3;

/** 大五人格 + 引擎扩展特质（对齐 awkn-agent PersonaTraits 部分字段） */
export interface PersonaTraits {
  openness?: number;
  conscientiousness?: number;
  extraversion?: number;
  agreeableness?: number;
  neuroticism?: number;
  formality?: number;
  humor?: number;
  proactivity?: number;
}

export interface PersonaRole {
  /** 人格唯一 id（沿用源 id：drucker/socrates/coder...） */
  id: string;
  /** 中文职能名（人格统一中文命名：产品顾问/思辨者/工程师...） */
  name: string;
  /** 人格系统提示词（注入 Worker prompt 头） */
  systemPrompt: string;
  personalityTraits: PersonaTraits;
  /** 忙碌时段（源语义保留，引擎暂不消费） */
  busyHours?: [number, number];
  /** 拒绝率（源语义保留） */
  declineRate: number;
  /** 头像（源语义保留） */
  avatar?: string;
  allowedTools?: string[];
  concurrentCompatible?: string[];
  memoryIsolation?: boolean;
  thinkingModels?: ThinkingModel[];
  collaboration?: CollaborationMap;
  /** 职责边界（"不做X，交Y"）→ Worker 防越权 */
  boundaries?: string[];
  responsibilities?: string[];
  stopConditions?: string[];
  /** 吸收溯源（如 mavis/drucker） */
  sourceAgent?: string;
  category?: AgentCategory;
  isHero?: boolean;
  /** 原拟人化名字（如 德鲁克/苏格拉底），保留溯源 */
  displayName?: string;
  aliases?: string[];
  // ─── 引擎侧扩展字段（组队选编用）─────────────────────
  /** 梯队分级 */
  tier: PersonaTier;
  /** 对应的 capabilities/project 开发环节 id */
  capabilities: string[];
  /** 使命关键词打分词表（persona-picker 用） */
  keywords: string[];
}

/** 人格库索引（agents/personas/personas.json） */
export interface PersonaIndex {
  schema: 'awkn-persona-index/v1';
  updatedAt: string;
  personas: Array<{
    id: string;
    name: string;
    tier: PersonaTier;
    category: AgentCategory | undefined;
    capabilities: string[];
  }>;
}
