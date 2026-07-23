# archive/AWKN-PROGRAMMER.md - AWKN 本命技能本地索引

来源路径: `C:\Users\10919\.workbuddy\skills\awkn-programmer`，仅作溯源，不作为运行依赖。
定位: 天火工程方法的本地事实源。默认启动不读取，工程任务按需读取本文件。

---

## 融合原则

- 天火本体负责身份、边界、治理链、能力判断和写回。
- AWKN 负责工程方法: 输入契约、任务拆解、最小步执行、质量门禁、安全审查、复盘进化。
- 本文件保存可运行路由和压缩规则；不要求运行时访问外部 AWKN 目录。
- 需要更新 AWKN 时，先在 `findings.md` 记录外部来源摘要，再写入本地索引候选。

---

## 本地路由表

| 触发 | AWKN 能力 | 天火动作 |
|------|-----------|----------|
| 任务判断、输入不完整、验收不清 | AI 执行总则与输入契约 | 形成 `intentPacket`，不清楚先过 `clarityGate` |
| 技术方案、任务拆解、实现路径 | 开发任务编排与最小步执行 | 生成最小可验证步骤，锁范围和回滚 |
| 测试、联调、质量、CI | 测试/联调与质量门禁 | 先定义验证，再执行测试或说明无法验证 |
| 安全、密钥、生产、数据、删除 | 安全审查规则 | 触发 `Risk` 和 `safetyGate`，等待确认 |
| 发布、上线、部署、回滚 | 发布/运维/监控规则 | 要求确认环境、回滚、验证路径 |
| 复盘、沉淀、能力进化 | 项目复盘与算法资产提取 | 输出 `evolutionWritebackPacket` |
| 相似经验、踩坑、历史规则 | 经验库索引 | 先读本地 `EXPERIENCE/`，再判断是否需要扩展 |

---

## AWKN 执行内核

```yaml
awknExecutionKernel:
  inputContract:
    goal: required
    scope: required_for_execution
    constraints: required_for_risk
    acceptance: required_for_done
  workUnit:
    maxStep: "最小可验证步"
    rollback: "每个高风险步骤必须有回滚"
    evidence: "命令输出 / diff / 测试 / 审查记录"
  qualityGate:
    code: "构建/测试/静态检查/人工说明"
    docs: "链接、路径、更新时间、使用入口"
    release: "环境、凭据、回滚、线上验证"
  evolution:
    success: "可复用经验候选"
    failure: "fixes 或 scars 候选"
    capabilityGap: "CAPABILITY 更新候选"
```

---

## 与 gstack 的分工

| AWKN 管什么 | gstack 补什么 |
|-------------|---------------|
| 工程主流程、输入契约、最小步执行 | 专项评审、浏览器 QA、安全审计、发布流水线 |
| 质量门禁原则 | live QA、review、benchmark、canary 的执行模式 |
| 复盘沉淀 | retro、learn、context-save/restore 的方法 |
| 安全边界 | careful/guard/freeze/cso 的专项检查 |

gstack 不替代 AWKN。天火先用 AWKN 判断任务阶段和边界，再按 `archive/GSTACK.md` 选择专项增强。

---

## 禁止

- 不把外部 AWKN 全文作为默认上下文。
- 不因为 AWKN 路由存在就跳过用户确认、安全门或验证门。
- 不把战略拍板、团队调度或生产操作自动化交给天火。
- 不把来源路径当作运行前置条件。

