# 核心 Loop 技能接入清单

> 版本：v1.0 ｜ 日期：2026-07-09 ｜ 状态：设计稿

## 结论先行

12 个 awkn-* 技能接入 Loop 系统，按角色分四类：前置理解、执行、验证、调度。已有项目修改走强制链，新项目按 Classify → Execute → Gate 三阶段路由。

---

## 一、12 个核心技能清单

| # | 技能名 | 在 Loop 中的角色 | 接入方式 | 触发条件 | 产出物 |
|---|-------|-----------------|---------|---------|-------|
| 1 | awkn-意图理解 | L1 前置 | 同步 Skill | `/goal` 解析后 | 意图结构化对象 |
| 2 | awkn-调研员 | L1 前置 | 同步 Skill | 意图含"调研/查/研究" | 调研报告 Markdown |
| 3 | awkn-spec | L2 前置 | 同步 Skill | 意图含"新功能/重构" | 冻结的技术方案 |
| 4 | awkn-工程文档 | L2 前置 | 同步 Skill | spec 产出后 | 接口/数据库/测试文档 |
| 5 | awkn-执行检查 | L1 验证 | 同步 Skill | 每轮 Turn 结束 | 五步门禁通过记录 |
| 6 | awkn-工程师 | L1/L2 执行 | 异步 Skill | orchestrator 调度 | 代码改动 + 测试 |
| 7 | awkn-审核 | 质量门禁 | 异步 Skill | reviewGate 触发 | 审核报告 PASS/FAIL |
| 8 | awkn-cicd | L2 评估器 | 同步 Skill | 停止判定阶段 | 评估器结果 |
| 9 | awkn-程序员天阶功法 | L2/L4 调度 | orchestrator | L4 模式启动 | 阶段调度计划 |
| 10 | awkn-复盘总结 | evolve 写回 | 异步 Skill | Loop 停止后 | 经验沉淀到 MEMORY |
| 11 | awkn-bug修复大法 | L2 专用 | 异步 Skill | 意图含"bug/修复/复现" | 修复 + 复现报告 |
| 12 | awkn-部署 | L4 手动 gate | 异步 Skill | L4 工作流末端 | 部署结果 |

---

## 二、按角色分组

### 2.1 前置理解类（L1 入口）

| 技能 | 何时调用 | 输入 | 输出 |
|------|---------|------|------|
| awkn-意图理解 | `/goal` 解析后第一时间 | 原始意图文本 | 结构化意图对象 |
| awkn-调研员 | 意图含外部信息需求 | 意图对象 | 调研报告 |

### 2.2 L2 前置冻结类

| 技能 | 何时调用 | 输入 | 输出 |
|------|---------|------|------|
| awkn-spec | 新功能/重构任务 | 意图对象 | 冻结技术方案 |
| awkn-工程文档 | spec 产出后 | 技术方案 | 工程交接文档 |

### 2.3 执行类

| 技能 | 何时调用 | 输入 | 输出 |
|------|---------|------|------|
| awkn-工程师 | orchestrator 调度执行 | 任务卡片 | 代码改动 + 测试 |
| awkn-bug修复大法 | bug 修复场景 | 复现条件 | 修复 + 复现报告 |

### 2.4 验证类

| 技能 | 何时调用 | 输入 | 输出 |
|------|---------|------|------|
| awkn-执行检查 | 每轮 Turn 结束 | 改动 diff | 五步门禁记录 |
| awkn-审核 | reviewGate 触发 | 改动 + 上下文 | PASS/FAIL |
| awkn-cicd | L2 停止判定 | 全量门禁结果 | 评估器结论 |

### 2.5 调度与写回类

| 技能 | 何时调用 | 输入 | 输出 |
|------|---------|------|------|
| awkn-程序员天阶功法 | L4 模式启动 | 任务 + 资源 | 阶段调度计划 |
| awkn-复盘总结 | Loop 停止后 | Loop 运行日志 | MEMORY 更新 |
| awkn-部署 | L4 工作流末端 | 构建产物 | 部署结果 |

---

## 三、调度规则

### 3.1 三阶段路由

每个 Turn 走三阶段：**Classify → Execute → Gate**。

| 阶段 | 职责 | 涉及技能 |
|------|------|---------|
| Classify | 路由意图到对应技能链 | awkn-意图理解 |
| Execute | 加载并执行技能 | awkn-工程师 / awkn-bug修复大法 / awkn-spec / awkn-工程文档 |
| Gate | 质量门禁拦截 | awkn-执行检查 / awkn-审核 / awkn-cicd |

### 3.2 Classify 阶段路由表

| 意图特征 | 路由到 |
|---------|-------|
| 含"bug/修复/复现" | awkn-bug修复大法 |
| 含"新功能/重构" | awkn-spec → awkn-工程文档 → awkn-工程师 |
| 含"调研/查/研究" | awkn-调研员 |
| 含"部署/发布" | awkn-部署（L4 末端） |
| 含"复盘/总结" | awkn-复盘总结 |
| 其他执行类 | awkn-工程师 |

### 3.3 Execute 阶段加载规则

| 规则 | 说明 |
|------|------|
| 按需加载 | 只加载当前 Turn 需要的技能，不全量加载 |
| 单 Turn 单技能 | 一个 Turn 内只执行一个执行类技能 |
| 异步执行 | 执行类技能异步跑，不阻塞 orchestrator |
| 预算隔离 | 每个技能调用有独立 token 预算 |

### 3.4 Gate 阶段拦截规则

| 规则 | 说明 |
|------|------|
| 强制顺序 | typecheckGate → testGate → lintGate → reviewGate |
| 短路原则 | 前一个 gate FAIL，后续 gate 不执行 |
| 反馈给 Agent | gate 失败原因回传给执行 Agent，进入下一轮 |
| 达到 max-rounds | 停止 Loop，标记未达成 |

---

## 四、已有项目修改强制链

**铁律**：已有项目任何代码修改必须走以下完整链，不可跳步。

```
awkn-执行检查
    ↓ （五步门禁：R→L→P→P→V）
awkn-spec （冻结方案）
    ↓
awkn-工程文档 （补接口/数据库/测试文档）
    ↓
awkn-程序员天阶功法 （L2/L4 调度计划）
    ↓
awkn-工程师 （执行实现）
    ↓
awkn-审核 （quality gate）
    ↓
awkn-cicd （L2 评估器判定停止）
    ↓
awkn-部署 （L4 手动 gate，需人工确认）
```

### 强制链说明

| 步骤 | 技能 | 必须产出 | 跳步后果 |
|------|------|---------|---------|
| 1 | awkn-执行检查 | 五步门禁通过记录 | 改动失控 |
| 2 | awkn-spec | 冻结技术方案 | 返工 |
| 3 | awkn-工程文档 | 工程交接文档 | 后续无法审核 |
| 4 | awkn-程序员天阶功法 | 阶段调度计划 | 节奏乱 |
| 5 | awkn-工程师 | 代码 + 测试 | — |
| 6 | awkn-审核 | PASS/FAIL | 质量失控 |
| 7 | awkn-cicd | 评估器结论 | 不知何时停 |
| 8 | awkn-部署 | 部署结果 | 误发布 |

### 例外情况

| 场景 | 可跳过 |
|------|-------|
| 纯文档修改 | 跳过 spec / 部署 |
| 紧急 hotfix | 跳过 spec，但必须补审核 |
| 实验性 spike | 跳过部署，标记不合并 |

---

## 五、技能接入格式

每个技能在 skills/ 目录下需提供以下文件才能被 Loop 系统接入：

| 文件 | 作用 |
|------|------|
| `SKILL.md` | 技能描述、触发词、参数 |
| `entry.js` / `entry.ts` | 入口脚本，接收 JSON 输入，输出 JSON |
| `manifest.json` | 元信息：角色、同步/异步、预算、依赖 |

### manifest.json 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 技能名 |
| role | enum | pre / execute / verify / schedule / post |
| sync | boolean | true 同步，false 异步 |
| budget | number | 单次调用 token 预算 |
| timeout | number | 执行超时 ms |
| depends | string[] | 依赖的其他技能名 |

---

## 六、技能与门禁的映射

| 门禁 | 主要依赖技能 |
|------|------------|
| typecheckGate | 无（运行时直接跑 tsc/mypy） |
| testGate | awkn-工程师（产出测试） |
| lintGate | 无（运行时直接跑 eslint/ruff） |
| reviewGate | awkn-审核 |
| securityGate | awkn-审核（安全子项） |
| verificationGate | awkn-执行检查 |
| budgetGate | 运行时 token 计数器 |

详见 `quality-gates.md`。

---

## 七、技能版本与兼容

| 规则 | 说明 |
|------|------|
| 技能版本 | manifest.json 含 version 字段 |
| 向后兼容 | Loop 运行时只认 manifest 字段，不依赖技能内部实现 |
| 热更新 | skills/ 目录变更后下个 Turn 自动重载 |
| 缺失处理 | 调用不存在的技能 → 退出码 1，记错误日志 |
