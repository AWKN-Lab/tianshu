# SOP.md - 天火轻量执行适配层

版本: v6.0
定位: 只保存天火本地轻量流程、AWKN 本命技能索引和 gstack 增强路由。

---

## 1. 轻量流程

```
Classify -> Fetch -> Plan -> Execute -> Review/Verify -> Evolve
```

| 阶段 | 必做 | 产物 |
|------|------|------|
| Classify | 判断 Q/A/P/S、复杂度、能否绕过；识别意图误读风险 | `taskClassificationPacket` |
| Fetch | 查能力、记忆、本地 AWKN/gstack 路由 | `fetchPacket` |
| Plan | 锁目标、范围、风险、验收；必要时复述确认 | `intentPacket` + `cardPlanPacket` |
| Execute | 执行最小可验证步 | 代码/文档/配置等产物 |
| Review/Verify | 审查发现、修复、用新证据关闭 | `reviewVerificationPacket` |
| Evolve | 写回或说明不写回 | `evolutionWritebackPacket` |

---

## 2. 复杂度路由

| 类型 | 条件 | 路径 |
|------|------|------|
| Query | 纯查询，无副作用 | 直接回答 |
| Simple | 1 文件、可回滚、无安全风险 | 轻量流程，必须验证 |
| Medium | 2-5 文件或单模块 | 轻量流程 + 本地 AWKN 任务拆解/测试 |
| Complex | >5 文件、跨模块、安全、发布、数据、长期资产 | 完整计划 + 本地 AWKN/gstack 索引 + 安全确认 |

---

## 3. AWKN 本地路由

本命技能索引: `archive/AWKN-PROGRAMMER.md`

| 触发 | 读取 |
|------|------|
| 任务判断/输入契约 | `archive/AWKN-PROGRAMMER.md#本地路由表` |
| 技术实现/任务拆解 | `archive/AWKN-PROGRAMMER.md#AWKN 执行内核` |
| 测试质量 | `archive/AWKN-PROGRAMMER.md#本地路由表` |
| 安全审查 | `archive/AWKN-PROGRAMMER.md#本地路由表` |
| 复盘进化 | `archive/AWKN-PROGRAMMER.md#AWKN 执行内核` |
| 经验检索 | `04-记忆与知识/EXPERIENCE/` + `archive/AWKN-PROGRAMMER.md` |

天火运行时只读本地索引。外部 AWKN 目录只作溯源，不作为运行依赖。

---

## 4. EntroCamp 意图对齐路由

来源索引: `archive/ENTROCAMP.md`
经验卡: `04-记忆与知识/EXPERIENCE/derived/EXP-DRV-20260423-001.md`

| 触发 | 动作 |
|------|------|
| 模糊词: 看看、优化、融入、随便、你看着办 | 识别歧义，给 A/B 选项或保守默认 |
| 用户说“不对/不是这个意思/经常错” | 先复述理解，再修正，不立刻辩解 |
| 同一问题或反馈出现 2 次 | 进入写回候选，判断是否形成长期规则 |
| 用户有累、忙、焦虑、来不及等状态信号 | 结论前置，少铺垫，必要时主动收缩范围 |
| 多方案选择 | 给权重或默认权重，不假设所有维度同等重要 |
| 时效性事实/具体数据 | 标注来源和时间；不确定时先验证 |

---

## 5. Deep/Recovery 能力路由

| 触发 | 模式 | 读取 |
|------|------|------|
| 长期任务、3+ 步、多轮研究、阶段验收 | deep | `modes/deep-mode.prompt` + `archive/PLAN-SKILL.md` + `task_plan.md/findings.md/progress.md` |
| 继续上次、卡住、上下文恢复、连续失败 | recovery | `modes/recovery-mode.prompt` + `task_plan.md/findings.md/progress.md` + compaction |
| 用户纠正、交付前自审、方向偏差 | review | `modes/review-mode.prompt` + `archive/AGENT-OPS.md` |
| 自主决策、能力缺口、重复失败、进化判断 | deep/review | `archive/AGENT-OPS.md` |

`plan` 和 `agent-ops` 都已本地化为 archive 索引，不进入 P0，不依赖源技能目录。

### 自主决策置信度

| 置信度 | 风险 | 动作 |
|--------|------|------|
| `>=80%` | 低 | 自主执行，记录理由 |
| `50-79%` | 低/中 | 记录假设后谨慎执行，必要时确认 |
| `<50%` | 任意 | 打 `Clarify` |
| 任意 | 高 | 打 `Risk` 并过 `safetyGate` |

### 3-strike 错误协议

1. 第 1 次失败: 诊断根因，针对性修复。
2. 第 2 次失败: 换方法、换工具或缩小范围。
3. 第 3 次失败: 停止重复尝试，汇报尝试、错误和选项。

---

## 5.1 Loop Engineering 执行流程 (v6.3 新增)

> 来源：`loop-engineering/README.md` + `loop-engineering/loop-commands.md`
> 把第 1 节线性流程升级为四层 Loop，按任务特征选层执行。

### L1 默认流程（Turn-based）

现有 6 步保留，**Execute 后强制加 Verify 步骤**：

```
Classify -> Fetch -> Plan -> Execute
  -> awkn-执行检查(Verify)   # v6.3 强制接入
  -> Review/Verify -> Evolve
```

| 步骤 | 执行 | 产物 |
|------|------|------|
| 1-4 | Classify→Fetch→Plan→Execute | 同第 1 节 |
| 5 | awkn-执行检查 Verify | 验证报告（fresh evidence） |
| 6 | Review/Verify + Evolve | reviewVerificationPacket + writeback |

未拿到 awkn-执行检查 Verify 报告，不得进入 Review/Verify。

### L2 /goal 执行流程（Goal-based，7 步）

| 步骤 | 动作 | 技能 | 产物 |
|------|------|------|------|
| 1 | 意图解析 | awkn-意图理解 | intentPacket |
| 2 | 方案冻结 | awkn-spec + awkn-工程文档 | spec + 交接包 |
| 3 | 循环体-调度 | awkn-程序员天阶功法 | 阶段 Handoff |
| 4 | 循环体-执行 | awkn-工程师 | 代码 + diff + 测试证据 |
| 5 | 循环体-门禁 | awkn-审核 + awkn-cicd | 审查报告 + Pipeline 结果 |
| 6 | 停止条件评估 | 确定性评估器 | 通过/未通过判定 |
| 7 | 复盘写回 | awkn-复盘总结 | evolutionWritebackPacket |

循环体（步骤 3-6）反复执行，直到停止条件全部满足或预算耗尽。

停止条件 4 项默认标准（确定性，禁止描述性判断）：

- 类型检查 0 错误
- 测试 0 failed
- lint 0 新增
- 审核 PASS

### L3 /loop 执行流程（Time-based）

| 步骤 | 动作 | 说明 |
|------|------|------|
| 1 | 声明 cron 任务 | `/schedule --cron "..." --task <名>` |
| 2 | CronEngine 调度 | 到点触发 |
| 3 | 执行 | 走 L1 或 L2 流程 |
| 4 | 上下文快照恢复 | 每轮结束存快照，下轮从快照恢复 |

约束：间隔必须匹配变化频率（PR 一小时一条就别 5 分钟轮询）。关机即停止。

### L4 预留（Proactive）

| 项 | 要求 |
|----|------|
| 启用条件 | L2 用顺 + 工作流已定型 |
| 组合 | CronEngine + Swarm 多 agent + auto mode |
| 门禁 | safetyGate + 用户明确确认 |
| 预算 | budgetGate + 3-strike 协议 |
| 默认状态 | 关闭 |

### 层级选择决策树

```
任务进来
  ├─ 纯查询、单步验证           -> L1
  ├─ 有明确完成标准（测试/类型/lint/审核） -> L2
  ├─ 周期性任务（巡检/监控/同步） -> L3
  └─ 无人值守定型工作流          -> L4（需确认 + safetyGate）
```

### 参考文档

命令详细参数和示例见 `loop-engineering/loop-commands.md`。

---

## 6. gstack 增强路由

索引: `archive/GSTACK.md`

| 触发 | 路由 |
|------|------|
| 浏览器 QA、真实交互、截图证据 | `browse` / `qa` 思路，过 `verificationGate` |
| 安全审计、密钥、供应链 | `cso` / `careful` / `guard` 思路，过 `safetyGate` |
| 架构/代码/设计/DX 评审 | 对应 review 思路，写 `reviewVerificationPacket` |
| 发布、PR、部署、canary | 高风险，用户确认后才执行 |
| 长任务保存/恢复/复盘 | 接 `task_plan.md`、`progress.md`、`EXPERIENCE` |

不运行 gstack 安装、升级、telemetry、自动 commit、cookie 导入、部署或外部 agent 协作能力，除非用户明确授权。

---

## 7. 节奏牌规则

| 牌 | 用途 |
|----|------|
| Clarify | 澄清关键缺口，最多 2 轮 |
| Shrink scope | 收缩过大范围 |
| Options | 多方案对比并选定 |
| Execute | 执行最小步 |
| Verify | 验证产物 |
| Fix | 修复验证失败项 |
| Rollback | 风险扩散时回退 |
| Risk | 安全/生产/密钥/数据风险抢占 |
| Nudge | 低成本推动下一步 |
| Pause | 连续高成本动作后留白 |

连续 3 张高成本牌后强制 `Pause`。上下文已足够时记录 `no_card`，不要重复打扰。

---

## 8. 完成报告最小格式

```markdown
结果:
- 交付:
- 验证:
- 风险/回滚:
- 进化写回:
```

没有验证证据时必须写”未验证原因”，不能写”完成”。

---

## 9. 主动行为中枢路由 (v1.1)

主动行为中枢: `scripts/active-hub/index.js`

### 9.1 触发条件

| 触发 | 调用 | 说明 |
|------|------|------|
| P0/P1 任务完成 | `activeHub.onTaskCompleted(task)` | 立即触发记忆+进化 |
| 任务失败 | `activeHub.onTaskFailed(task, error)` | 触发进化分析 |
| 重大技术决策 | `activeHub.onDecisionMade(decision)` | 触发决策记录 |
| 成功经验发现 | `activeHub.onSuccess(success)` | 触发经验提取 |
| 健康异常检测 | `activeHub.onHealthDegraded(health)` | 触发预警 |

### 9.2 失败恢复协议

失败恢复只允许工程化处理，不使用攻击性、羞辱性或情绪化话术。

| 场景 | 动作 | 证据 |
|------|------|------|
| 第 1 次失败 | 记录错误、定位根因、做针对性修复 | 错误摘要 + 下一步 |
| 第 2 次失败 | 换方法、换工具或收缩范围 | 对比说明 + 新验证 |
| 第 3 次失败 | 停止重复尝试，输出已试路径、阻塞和选项 | `progress.md` 或结果摘要 |
| 用户纠正方向 | 先复述新理解，再更新计划 | `intentPacket` |
| 无法验证 | 说明原因，不宣称完成 | `reviewVerificationPacket` |

三条铁律:
1. 不重复执行同一个失败动作。
2. 不把失败责任推给用户；先给已验证事实。
3. 不用计划替代安全门、验证门或写回门。

### 9.2 任务关键程度快速判断

在天火上下文中，可用以下规则快速判断：

```javascript
// P0: 生产环境改动 / 不可逆操作 / 用户面向核心功能
// P1: 跨系统改动 / 新功能开发 / 安全相关
// P2: 单模块改动 / 可回滚改动 / 有测试覆盖
// P3: 文档更新 / 简单修复 / 临时任务
```

### 9.3 调用方式

在任务的 **Evolve** 阶段，根据任务类型调用：

```
Evolve 阶段:
  if (P0/P1 任务完成) {
    调用 activeHub.onTaskCompleted(taskInfo)
  }
  if (任务失败) {
    调用 activeHub.onTaskFailed(taskInfo, error)
  }
  if (发现成功模式) {
    调用 activeHub.onSuccess(successInfo)
  }
```

### 9.4 任务信息结构

传递给主动行为中枢的任务信息应包含：

```yaml
taskInfo:
  id: “任务唯一ID”
  name: “任务名称”
  type: “code|decision|research|collab”
  environment: “production|staging|development”
  userFacing: true|false
  crossSystem: true|false
  codeChanges:
    lines: 100
    files: [“file1”, “file2”]
  dependencies: [“api”, “database”]
  domains: [“backend”, “frontend”]
  rollback: “easy|moderate|hard”
  dataImpact: “none|recoverable|permanent”
```

### 9.5 主动行为中枢状态检查

如需检查主动行为中枢状态：

```javascript
const { activeHub } = require('./scripts/active-hub/index');
console.log(activeHub.getStatus());
// { initialized, eventBus: { queueLength, subscriberCount, isProcessing } }
```
