# Tianhuo v2.0 — 架构决策记录 (Architecture Decision Records)

> 文档定位:6 个关键架构决策的"为什么 + 备选 + 取舍"完整记录。
> 适用:任何想理解"为什么 v2.0 是这样,不是那样"的人 + 未来做 v3.0 决策时参考。

---

## ADR-001: agent.md 缩到 80 行 + 12 个 subsystem 文件

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

v1.1 把所有规则塞进 agent.md 280 行。结果:调一处要翻 280 行找上下文,改了容易出"幽灵规则"(改了 prose 但忘了同步)。

### 决策

- agent.md 缩到 80 行,只留 7 段大纲
- 详细规则拆到 12 个 subsystem 文件
- 每个 subsystem ≤ 200 行,职责单一

### 备选

- **方案 A: 保持 280 行,加目录索引** — 拒绝,根问题没解决
- **方案 B: 拆成多个 agent**(天火-v1, 天火-v2, ...) — 拒绝,增加路由复杂度
- **方案 C: 用单一 config 文件 + 动态加载** — 拒绝,YAML 太灵活,容易失控

### 取舍

- ✅ 找特定规则变快(知道去哪个文件)
- ✅ 修改影响面小(改 state-machine.ts 不影响 agent.md)
- ❌ 文件数变多(从 1 → 25+)
- ❌ 跨文件理解需要先读 docs/interface.md

### 后果

- 新人 onboarding:先读 agent.md 7 段 + docs/interface.md
- 修改流程:改 subsystem → 改 docs/changelog → 改 docs/interface(如果接口变了)

---

## ADR-002: L1-L4 任务分级从 prose 变 typed enum + state machine

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

v1.1 agent.md 出现 ~20 次"L1/L2/L3/L4",但都是 prose,机器读不出来,不能自动化。

### 决策

```typescript
type TaskClass = 'L1' | 'L2' | 'L3' | 'L4'
type TaskInput = {
  taskClass: TaskClass
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  hasUserConfirmation: boolean
  // ...
}
type TaskState = { /* 9 个可能状态 */ }
function decideState(input: TaskInput): TaskState
```

- typed enum 强制类型
- state machine 函数化
- 纯函数(deterministic)

### 备选

- **方案 A: 保持 prose,加正则提取** — 拒绝,脆弱
- **方案 B: 用 YAML 状态表** — 拒绝,机器验证弱
- **方案 C: 用第三方库(xstate)** — 拒绝,引入依赖,过度工程

### 取舍

- ✅ 类型安全(TS 编译检查)
- ✅ 纯函数可测试(state-machine.test.ts)
- ✅ 决策可审计(decision log)
- ❌ 多了一个 .ts 文件
- ❌ TS 不是 Mavis 原生(但能跑)

### 后果

- 调天火的所有地方传 `taskClass: 'L1' | 'L2' | 'L3' | 'L4'`
- 旧 prose 里的 L1-L4 引用都改 enum

---

## ADR-003: trigger 用 YAML 不写代码

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

v1.1 的 "if X then Y" 散在 prose 27 处,改 trigger 要改 agent.md,容易被忽略。

### 决策

- triggers 用 yaml 数据
- 每个 trigger 有 id / condition / action / priority
- 主循环读 yaml 触发

```yaml
triggers:
  - id: "L3-promote-to-AWKN"
    condition: "state.taskClass === 'L3' && !state.hasUserConfirmation"
    action: "promote-to-full-chain"
    priority: 1
```

### 备选

- **方案 A: trigger 写 TS** — 拒绝,改 trigger 要重新部署
- **方案 B: trigger 写 JSON** — 拒绝,JSON 不可注释
- **方案 C: 用规则引擎(json-rules-engine)** — 拒绝,过度工程

### 取舍

- ✅ 改 trigger 不动代码
- ✅ 非工程师也能改 routing
- ✅ yaml 天然支持注释
- ❌ 没有 TS 类型(用 zod 验证可以补)
- ❌ condition 表达式是字符串(不能编译检查)

### 后果

- 加新 trigger:在 triggers.yaml 加一段,无需改 agent.md
- 调 trigger 行为:改 yaml,无需重启
- 调试 trigger:看 observability trace 找命中

---

## ADR-004: 5 gates → 7 gates(新增 risk + cost)

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

v1.1 5 gates: clarity / planning / safety / verification / evolution。
缺 2 个: 风险评估 / 成本评估。

### 决策

加 2 个 gate,共 7:
- **riskGate** — 评估任务风险等级(low/medium/high/critical)
- **costGate** — 评估 token / 钱 / 时间的消耗

跟 awkn-agent 的 7-gates 对齐。

### 备选

- **方案 A: 保持 5 gates,加 risk/cost 列** — 拒绝,逻辑差异大,放一起乱
- **方案 B: 改成 5+2 概念(risk/cost 是子 gate)** — 拒绝,治标不治本
- **方案 C: 完全用 awkn-agent 的 7-gates,无差异** — 拒绝,工程 vs 战略差异需要适配

### 取舍

- ✅ 风险评估独立(影响决策不同)
- ✅ 成本评估独立(影响调度不同)
- ✅ 跟 awkn-agent 对齐(可借鉴)
- ❌ 闸门多了 2 个,流程稍重
- ❌ 7 个 gate 都要配置

### 后果

- 旧 plan(只跑 5 gate)仍工作(v2.0 是 additive)
- 新 L3 任务跑全 7 gate
- risk/cost gate 的 mode 默认 confirm(可降为 auto)

---

## ADR-005: safety-intercept 独立成 yaml,不放进触发器

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

触发器是"业务逻辑",拦截器是"安全逻辑"。混在一起会乱:
- 改 trigger 担心触发安全改动
- 改 intercept 担心影响业务
- 安全拦截需要在主循环里**同步**执行(不能等异步)

### 决策

- 触发器放 `triggers.yaml`
- 安全拦截放 `safety-intercepts.yaml`
- 主循环先跑 intercept(同步),再跑 triggers(可异步)
- intercept 是 hard block,无 mode 选项

### 备选

- **方案 A: 放一起(triggers + intercepts)** — 拒绝,关注点不同
- **方案 B: intercept 写代码(不 yaml)** — 拒绝,改拦截要重新部署
- **方案 C: 用第三方鉴权库(OPA)** — 拒绝,过度工程,正则够用

### 取舍

- ✅ 安全逻辑独立
- ✅ 同步执行(安全不能异步)
- ✅ hard block 强制
- ❌ 多一个 yaml 文件
- ❌ 主循环要写 2 步(先 intercept 再 trigger)

### 后果

- 改 trigger 不影响安全
- 改 intercept 不影响业务
- 调试时分别看 trace

---

## ADR-006: observability 用本地文件,不用 OTel collector

**状态**: ✅ Accepted (v2.0)
**日期**: 2026-06-05
**决策者**: 老板 + Mavis

### 背景

生产级 observability 用 OTel collector + jaeger/tempo,部署复杂。天火是 agent,不是 production service,需要简化。

### 决策

- trace 写本地文件 `observability/engineering-logs.yaml`
- 格式对齐 OTel span(trace_id / span_id / parent / duration)
- 后续可加 OTel collector 导出(增量)

### 备选

- **方案 A: 直接用 jaeger/otel-collector** — 拒绝,部署复杂
- **方案 B: 写 console.log** — 拒绝,不可查
- **方案 C: 不记录(回到 v1.1 状态)** — 拒绝,根本问题没解决

### 取舍

- ✅ 零外部依赖
- ✅ 文件可 grep / tail / 聚合
- ✅ 格式 OTel 兼容,后续可导出
- ❌ 跨主机不行(单机)
- ❌ 高频任务文件会大

### 后果

- 调试时:tail + grep
- 周报时:聚合 yaml 文件
- 升级路径:v2.1 加 OTel collector 导出

---

## 未决(留作 v2.1+)

- 是否用 zod 验证 yaml schema(目前 yaml 字符串没编译检查)
- 是否把 12 个 subsystem 编成一个 npm 包(目前是文件)
- 是否加 OTel collector(目前本地文件)
- 是否加 multi-agent 协作(目前单 agent)

---

## 决策流程(留作未来参考)

1. 识别决策点 — 写"我们要做 X,但有 Y 个方案"
2. 列备选 — 至少 2 个
3. 取舍 — 每个方案列 ✅ 和 ❌
4. 选一个 — 写明理由
5. ADR 写入本文 — 不可改,只可 append "Superseded by ADR-XXX"
6. 实施 — 在 changelog 里 link 这个 ADR
