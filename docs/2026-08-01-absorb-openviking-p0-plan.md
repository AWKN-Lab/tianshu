# Absorb OpenViking P0 — 实施计划

日期：2026-08-01
分支：`feat/absorb-openviking`
来源分析：docs 对话《OpenViking 深度分析》（AGPLv3 合规：仅机制级移植，不复制代码）

## 目标

将 OpenViking 五项 P0 机制以 TypeScript 独立实现移植进 runtime，提升 AWKN 记忆质量与工程健壮性。

## 范围

| # | 能力 | 落点 | 说明 |
|---|---|---|---|
| P0-1 | 真实 Embedding + Rerank | `memory/embedding.ts`、`llm/` | OllamaEmbeddingProvider（HTTP，可选，缺省仍为 Hash 兜底）；RerankProvider 接口 + 对称重排实现 |
| P0-2 | L0/L1/L2 分层 + 目录递归检索 | `memory/service.ts`、`context/` | 记忆目录树 + 目录分数优先队列 + 父分数传播 + 收敛提前终止 + 热度衰减；检索轨迹 |
| P0-3 | schema 驱动记忆提取 + merge_op | `memory/extract/` | prefetch → LLM 结构化操作（zod 契约）→ merge_op 链式合并；LLM 不可用降级原文记录 |
| P0-4 | 持久队列 + at-least-once | `store/queue.ts`、`memory/async-worker.ts` | SQLite 队列：pending/in_progress/ack 删除、租约、崩溃 stale 重排 |
| P0-5 | 指标 TTL/SWR | `observability/metrics.ts` | label 契约、series 上限、TTL 门控、SWR 后台刷新、deadline 并行 |

## 阶段

1. P0-1 接口与实现 + 测试 → typecheck ✅（embedding/rerank，7 测试）
2. P0-2 分层检索 + 轨迹 + 测试 → typecheck ✅（hierarchical 6 测试，迁移 v15）
3. P0-3 提取循环 + merge_op + 测试 → typecheck ✅（extract 9 测试，迁移 v17，接入队列）
4. P0-4 持久队列 + worker + 测试 → typecheck ✅（queue 7 测试）
5. P0-5 指标注册表 + 测试 → typecheck ✅（metrics 10 测试）
6. 全量 `npm run check` + 架构扫描 ✅（unit 276/276、contracts 全过除并行会话 cron P1-3 语义变更 1 项、verify 过、tsc=0、architecture=0）

## 风险

- 工作区已存在大量未提交改动（main 带过来的），改动需与既有工作共存，合并时人工确认
- SQLite 迁移（queue 表 / memory path/level 列）需同时维护两套迁移注册表
- LLM 提取循环依赖外部模型：设计为可注入、可降级、可离线测试
- Embedding 维度变化导致旧向量不可比：cosine 维度不一致返回 0，不破坏存储

## 验证

- 每阶段：新增 unit/contract tests 通过
- 最终：`npm run check`（architecture-scan + tsc + lint + unit + contracts + verify）

## 退出标准

- P0-1..P0-5 全部合入 `feat/absorb-openviking`，`npm run check` 全绿
- 默认路径（未配置外部 embedding）行为与吸收前一致（向后兼容）
