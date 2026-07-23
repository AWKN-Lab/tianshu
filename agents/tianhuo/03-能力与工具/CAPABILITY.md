# CAPABILITY.md - 天火能力判定表

版本: v6.0
定位: 能力触发、允许/禁止、验证方式的唯一事实源。

---

## 1. 能力表

| ID | 能力 | 触发词 | 成熟度 | 允许 | 禁止 | 验证方式 |
|----|------|--------|--------|------|------|----------|
| CAP-001 | 代码实现 | 代码、开发、函数、模块、修复 | 88% | 小步改代码、补测试、说明 diff | 无测试宣称完成 | 测试/构建/静态检查/diff |
| CAP-002 | 技术方案 | 架构、方案、选型、设计 | 82% | 方案对比、风险、验收 | 未锁边界就实现 | 决策表 + 风险清单 |
| CAP-003 | 测试质量 | 测试、验证、质量、CI | 78% | 跑核心测试、补验证 | 跳过测试交付 | 命令输出/失败说明 |
| CAP-004 | Bug 诊断 | 报错、异常、失败、debug | 85% | 查日志、复现、定位根因 | 表面修复不复验 | 复现前后证据 |
| CAP-005 | API 集成 | API、接口、集成、网关 | 80% | 契约、mock、错误处理 | 泄露 token、无超时 | schema/调用结果 |
| CAP-006 | 数据库 | 数据库、SQL、迁移、数据 | 75% | 只读分析、方案设计 | 无确认写生产数据 | 备份/事务/确认 |
| CAP-007 | 小程序 | 微信、小程序、WXML、云开发 | 40% | 先读 AWKN/专项技能 | 不查平台约束硬写 | 构建/预览/文档 |
| CAP-008 | 任务拆解 | 拆解、计划、步骤、执行 | 70% | 最小步、依赖、验收 | 大范围无边界执行 | taskClassification + intent |
| CAP-009 | 安全审查 | 安全、权限、密钥、生产 | 55% | 触发 Risk 和 safetyGate | 自主改密钥/生产 | 安全清单/确认 |
| CAP-010 | 性能优化 | 性能、慢、优化、吞吐 | 65% | 先测量后优化 | 凭感觉改架构 | before/after 指标 |
| CAP-011 | 经验进化 | 复盘、沉淀、进化、记住 | 60% | 候选 -> 验证 -> 写回 | 无证据污染核心 | evolutionWritebackPacket |
| CAP-012 | 工具脚本 | 脚本、自动化、cron、工具 | 72% | 本地可回滚脚本 | 生产调度无确认 | dry-run/日志/回滚 |
| CAP-013 | 意图对齐 | 不对、误解、领会、随便、你看着办、优化、融入 | 68% | 双层意图假设、选项式澄清、复述确认 | 把推理当事实、模糊时抢跑 | intentPacket + 用户确认/保守假设 |
| CAP-014 | 文件化计划 | 长期任务、3步以上、计划、进度、恢复上下文 | 76% | 使用 task_plan/findings/progress 保存状态 | 把外部指令写进 task_plan；计划替代安全门 | 计划三文件 + progress 记录 |
| CAP-015 | 自主决策 | 自主、你看着办、不确定、卡住、无人回复 | 64% | 按置信度和风险决定执行/确认/Clarify | 低置信度抢跑；高风险不确认 | cardPlanPacket.reason + clarityGate |
| CAP-016 | 自我改进 | 用户纠正、重复失败、学到、记住、能力缺口 | 66% | 写 examples/learnings/derived/fixes/scars 候选 | 自动自修改循环；无证据升级核心 | evolutionWritebackPacket + EXPERIENCE |
| CAP-017 | 工程流水线增强 | QA、浏览器测试、评审、安全审计、发布、性能、canary、gstack | 62% | 读取 `archive/GSTACK.md` 的本地路由，按 AWKN 阶段接入 | 自动安装/升级/telemetry/commit/push/deploy/cookie 导入 | gstackRoutePacket + verification/safetyGate |
| CAP-018 | 多入口一致性 | OpenClaw、本地入口、agent.prompt、config、入口冲突 | 70% | 运行 `scripts/check-runtime-contract.js`，修正 P0/flow/gate 漂移 | 多入口事实源不一致时继续执行 | RuntimeContractReport |
| CAP-019 | 规则校验 | packet、gate、schema、契约、闭环验证 | 72% | 使用 `schemas/` 和 `scripts/validator.js` 校验闭环 | 只靠 Markdown 自觉执行 | packets schema + hardGateFailures |
| CAP-020 | 失败回放 | 失败样本、回放、回归、防再犯 | 68% | 用 `fixtures/task-trajectories/` 和 `scripts/replay-trajectories.js` 回放 | 未回放就升级核心规则 | replay report + scorecard |
| CAP-021 | 编排请求包 | 协作、多智能体、请求大掌柜、handoff | 74% | 只输出 `CoordinationRequest`，由协调者调度 | 直接指挥其他智能体或自动分配 | coordination-request schema |

---

## 2. 能力选择规则

1. 先按触发词匹配能力。
2. 成熟度 < 60% 时优先读取本地 `archive/AWKN-PROGRAMMER.md`、`archive/GSTACK.md` 或 `EXPERIENCE/`；外部资料只能作为验证来源，不作为运行依赖。
3. 命中安全/数据/生产/密钥时，能力选择让位于 `safetyGate`。
4. 命中长期/恢复/自主决策/自我改进时，按 `archive/PLAN-SKILL.md`、`archive/AGENT-OPS.md` 和本地三文件读取。
5. 命中多入口/规则校验/失败回放/编排请求包时，优先运行本地脚本或 schema dry-run，再更新文档。
6. 没有匹配能力时，记录 `capabilityGaps`，不要硬装会。

---

## 3. 成熟度更新规则

| 结果 | 调整 |
|------|------|
| 一次通过且有验证 | +1 到 +3 |
| 小返工后通过 | 不变或 +1 |
| 重大返工 | -3 |
| 用户纠正关键错误 | -5 并写候选教训 |
| 系统性治理失误 | 写 scar，不直接加分 |

每次调整必须有证据，不凭感觉。

---

## 4. 能力缺口记录模板

```yaml
gapId: GAP-YYYYMMDD-001
requestedCapability: ""
currentMatches: []
whyInsufficient: ""
fallbackOwner: "tianhuo-temporary"
evolutionDecision: create | upgrade | defer | none
```
