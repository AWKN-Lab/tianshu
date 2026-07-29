# ADR-001: AWKN Review Kernel v1

- 状态：Accepted
- 日期：2026-07-28
- 决策者：AWKN Runtime maintainers

## 背景

旧审核链路让模型输出自然语言，再解析 `VERDICT: PASS|FAIL`。它不能证明审核目标未变化、文件没有漏审、Finding 位置有效，也无法稳定回放。自由文本只能作为兼容视图，不能继续作为门禁事实。

## 决策

Runtime 新增第一方 `review` 组件，按 `prepare → plan → execute → evaluate` 运行。OpenCodeReview 只提供确定性的 Git 范围与规则分组；AWKN 负责 Reviewer 路由、跨文件与规格单元、Finding 校验、覆盖率、Verdict、Receipt 和门禁。

OCR 的最小机器协议集成只能存在于 AWKN 仓库的 `integrations/open-code-review/`。外部 checkout 可以用于只读比较，但不能被 Runtime 执行、不能成为构建输入，也不能保存 AWKN 修改。

核心不变量：

1. 调模型前冻结 `ReviewTarget`；目标、文件和规则均有 SHA-256 指纹。
2. `ReviewPlan` 由稳定投影计算，排除 Actor 和时间；仓库根路径纳入绑定以避免不同仓库在相同 Diff 下发生目标碰撞。同一冻结仓库目标可跨入口复算。
3. 测试文件默认纳入；Planner 独立创建 `FILE/CROSS_FILE/SPEC/TEST_ABUSE` 单元。
4. Reviewer 实际 Actor 必须与实现者不同。单元最多尝试两个不同 Reviewer；失败为 `PARTIAL`。
5. Finding 必须位于冻结文件的可见 Diff 行，并引用本次执行 Evidence。Critical/High 还需独立 Reviewer 或确定性工具验证。
6. Coverage、Finding 和目标状态由 Runtime 确定性计算。`FAIL/PARTIAL/STALE/INVALID` 均映射 Gate FAIL。
7. `awkn-review-receipt/v1` 是唯一审核事实；Markdown 只是展示。
8. Security Gate 使用独立安全证据，不复用 Review 文本。

## 组件边界

- `contracts/review.ts`：严格版本契约、稳定 Hash 与 fail-closed 约束。
- `review/application`：规划、校验、覆盖率、Verdict、Receipt 和服务。
- `review/adapters/outbound`：OCR CLI 与 Native Git Provider。
- `integrations/open-code-review`：引擎内上游锁、许可证、最小薄分支源码/补丁与本机构建边界。
- `adapter/llm-reviewer-adapter.ts`：AWKN LLM Router 的结构化 Reviewer。
- `adapter/sqlite-review-audit-adapter.ts`：Receipt、Evidence、Event 的事务持久化。
- `gates/quality-gates.ts`：只把结构化 PASS 映射为 Gate PASS。

依赖方向由 architecture scan 约束：contracts 不依赖业务组件，review 核心不依赖具体模型或数据库适配器。

## 模式

- `AWKN_REVIEW_OCR_V1=0`：兼容旧链路。
- `shadow`：旧 Gate 仍权威，同时持久化 `REVIEW` 与 `SHADOW_DIFF` Receipt。
- `enforce`：结构化 Receipt 权威；Provider、协议或执行异常 fail-closed。

`NativeGitReviewAdapter` 支持工作树和 commit range。OCR v1 只支持 commit range；能力不足不得伪装完整结果。

## 被拒绝的方案

- 完整移植 OCR 到 TypeScript：维护面过大且形成第二实现。
- 解析 OCR Markdown：非稳定机器协议，无法严格校验。
- OCR Full Mode：会形成第二套模型密钥、会话与审计事实。
- 模型直接决定 Gate：不能证明覆盖率、目标新鲜度或 Actor 独立性。

## 发布条件

Runtime 能力完成不等于质量指标达标。转 enforce 前必须在真实语料运行两个观察周期，并满足：计划文件覆盖率 100%、植入 Critical/High 召回率 100%、Finding 精确率 ≥85%、Critical/High 位置有效率 ≥99%、零安全误 PASS、所有故障注入 fail-closed。指标必须来自 Receipt 聚合，不得人工填写。
