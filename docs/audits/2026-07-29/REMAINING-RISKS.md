# REMAINING-RISKS

> 审计日期：2026-07-29  
> 范围：本次补丁应用后的剩余风险

## 1. 本仓库缺口

### 1.1 P0：Goal Judge 尚未控制完成态

- `AgentLoop.runL2()`、`TianhuoCicdLoop`、`PrdCentricLoop` 仍可由 model actor 直接将 Goal 写为 `achieved`；
- `judgeGoal()` 具备合同实现，但缺少生产输入和调用边；
- 当前旧 Gate 通过不能证明 Delivery、Evidence Binding、Outcome 和 Memory Write 条件齐备。

建议顺序：

1. 定义 `GoalJudgementPort` 和 receipt persistence；
2. 在 Mode 0 生成 judgement，仅记录；
3. Shadow 对比旧完成态和 Goal Judge verdict；
4. 达到退出指标后进入 Enforce；
5. Enforce 中移除 `model` 的 achieved 写权限；
6. 为 paused、budget_limited、证据缺失、Delivery 缺失添加负向测试。

### 1.2 Agent OS 3.0 主链仍断开

- `ExecutionCoordinator` 只编排 Input、Intent、Context、Claim；
- Policy/Skill/Broker/Evidence Loop 未接入；
- Delivery 与 Outcome 没有生产实现；
- envelope 的 run/delivery/memory/evolution refs 为空；
- contextReceipt 和 claimReceipt 当前没有返回或持久化。

风险：组件合同可能各自通过，系统级数据流仍无法完成。

### 1.3 ACTIVE 资产未回灌

- Evolve 的候选晋级与 ACTIVE 状态可发生；
- Policy Compiler、Skill Compiler、SkillsManager、AgentLoop 没有消费 ACTIVE snapshot；
- 重启后 `SkillEvaluationRegistry` 状态丢失；
- 缺少 execution → asset version/hash 的可追溯绑定。

风险：系统对外显示“已晋级”，下一次运行行为保持原状。

### 1.4 Skill Preflight 为占位逻辑

- `preflightContext` 被忽略；
- Preflight 统一通过；
- compatibility risk 固定为 0；
- historical score 缺 Outcome 聚合来源。

风险：高风险或缺依赖技能可进入 bundle，评分缺少可验证来源。

### 1.5 TRAE provider 可用性误判

- `TraeProvider.isAvailable()` 固定返回 true；
- hook 无响应且 daemon 处于离线状态时，单次调用可等待 120 秒；
- fallback 只在超时后开始。

建议：daemon heartbeat、hook capability TTL、短探测超时、不可用时直接返回 false。

### 1.6 文件桥多进程 claim 缺失

本补丁提供原子请求/响应写入，仍存在：

- 两个 daemon 可同时读取同一 req；
- 两个模型调用均可能发生；
- 只有响应文件写入竞态被收敛；
- 缺 lease、owner、attempt、expiresAt 和崩溃恢复协议。

建议：`req-*` 原子 rename 到 `processing-<daemon>-*`；记录租约和重试次数；过期后可重领；最终响应使用 idempotency key。

### 1.7 Outcome 写入为死代码

`MemoryBackendRouter.recordRunOutcome()` 没有调用点。Run terminal 只进入本地 EventStore 路径，远端 Outcome Attribution 不可达。

建议：订阅 `run.terminal` Domain Event；使用 `run:<id>:terminal:<status>` 幂等键；强制 Memory OS 模式下按 fail-closed 处理。

### 1.8 测试与 CI 覆盖空洞

- 23 个 `verify-*.ts` 未被测试发现器执行；
- `lint` 与 `typecheck` 重复；
- `npm run check` 没有单独 `build`；
- 架构扫描对部分核心目录仍为报告级。

建议将验证脚本分类为稳定合同、E2E、外部 smoke；所有 CI 任务输出显式发现清单和 skipped 原因。

## 2. AWKN Memory OS 对端缺口

本仓库无法证明以下对端能力已实现：

- Descriptor 与版本协商完整契约；
- Project Grant 的签发、刷新、撤销、作用域和审计；
- Context Receipt/Render 的权威存储与不可变约束；
- Consume 与 Outcome Attribution 的事务一致性；
- CAS 事务冲突语义；
- Idempotency 跨重启和跨副本语义；
- Tombstone、撤销传播和读取过滤；
- Outbox 至少一次投递、去重和隔离恢复；
- Authority rule 的审批、激活、暂停、撤销和回滚；
- 支持版本矩阵及不兼容升级行为。

### 2.1 必要对端证据

- Memory OS commit SHA；
- OpenAPI/JSON Schema 或协议合同；
- 数据库迁移版本；
- 真实服务启动方式；
- 最小无敏感信息测试 Grant；
- 双仓 smoke 日志；
- receipt/trace 示例；
- 失败注入结果；
- 清理和回滚证明。

## 3. 真实 TRAE/Codex IDE 验证缺口

### 3.1 TRAE

缺少：

- IDE 版本和宿主 API 文档；
- hook 安装/发现流程；
- 工作区身份与权限边界；
- 宿主回调超时和取消；
- IDE 重启恢复；
- 多工作区隔离；
- 凭据不穿越文件桥的证明；
- 一次真实模型调用的端到端 trace。

### 3.2 Codex

当前 `CodexProvider` 只证明 OpenAI-compatible API 调用。Codex IDE 仍需：

- 明确宿主契约；
- 会话与工作区绑定；
- 工具调用和审批回路；
- 中断、重试、恢复；
- IDE 侧版本和日志；
- 独立 E2E 测试名称与状态。

## 4. 生产验证缺口

未验证项目：

- 多进程 daemon 并发和崩溃恢复；
- Windows、Linux、网络盘路径差异；
- 长时间运行的文件清理和磁盘上限；
- Memory OS 网络抖动、429、5xx、超时和恢复；
- 大规模 outbox 与隔离队列；
- SQLite 锁争用和进程恢复；
- Shadow 到 Enforce 的发布指标；
- 回滚后 ACTIVE asset 和运行快照一致性；
- 真实凭据生命周期、日志脱敏和最小权限；
- 生产数据迁移与恢复。

## 5. 推荐验收优先级

| 顺序 | 目标 | 退出条件 |
|---:|---|---|
| 1 | Goal Judge Mode 0/Shadow 接入 | 每次旧完成判定均有 judgement receipt；无越权 achieved 写入新增路径 |
| 2 | C04-C09 单链接入 | ExecutionEnvelope 各 ref 有真实产物，Delivery/Outcome/Memory/Evolve 可追踪 |
| 3 | ACTIVE asset 回灌 | 下一次运行记录实际使用的 asset id/version/hash，重启后保持 |
| 4 | 测试发现和真实 lint | verify 分类进入 CI；lint 使用独立规则集；build 纳入门禁 |
| 5 | Memory OS 双仓 smoke | 401/403/协议/CAS/幂等/Outbox/撤销场景全部有真实服务证据 |
| 6 | TRAE/Codex IDE E2E | 真实宿主会话、恢复、并发和权限证据齐全 |
| 7 | 生产 Shadow | 达到预设成功率、差异率、误阻断率和回滚指标后评估 Enforce |

## 6. 发布建议

本次补丁适合进入独立审计分支，由 CI 在正常 npm registry 环境复验。合并前至少需要：

- Node 20、Node 22、Windows Node 20 的 `npm ci`；
- architecture、typecheck、真实 lint、unit、contract、build；
- 新增 Memory 和 bridge 定向测试；
- 复核强制 Memory OS 模式的业务影响；
- 保持 Engine v2 默认路径和 Feature Flag 发布边界。
