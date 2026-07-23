# Loop 命令清单

> 版本：v1.0 ｜ 日期：2026-07-09 ｜ 状态：设计稿

## 结论先行

五个命令覆盖四层 Loop：`/goal` 起一个目标 Loop，`/loop` 控制循环参数，`/schedule` 定时触发，`/hook` 注册短平快钩子，`/skill` 调用具体技能。命令解析层薄，业务在运行时模块。

---

## 一、命令总览

| 命令 | 层级 | 作用 | 运行时模块 |
|------|------|------|----------|
| `/goal` | L2 | 设定目标 + 停止条件，启动 Goal Loop | `runtime/commands/goal.ts` |
| `/loop` | L2/L3 | 控制循环参数（轮数、预算、间隔） | `runtime/commands/loop.ts` |
| `/schedule` | L3 | 时间驱动触发 Loop | `runtime/scheduler/schedule.ts` |
| `/hook` | L1-L4 | 注册同步短平快钩子 | `runtime/commands/hook.ts` |
| `/skill` | L1-L4 | 加载并调用指定 Skill | `runtime/commands/skill.ts` |

---

## 二、/goal 命令

### 定位

L2 入口。**只写意图，不写步骤**。停止条件由 L2 默认标准集 + 用户覆盖组成。

### 语法

```
/goal <意图描述> [--stop <条件集>] [--budget <token>] [--max-rounds <N>]
```

### 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| 意图描述 | 是 | — | 一句话目标，不写实现步骤 |
| `--stop` | 否 | L2 默认4项 | 停止条件集，逗号分隔 |
| `--budget` | 否 | 200k token | 总 token 预算 |
| `--max-rounds` | 否 | 20 | 最大轮数硬上限 |

### 意图模板（强制）

写 `/goal` 时按以下模板组织意图，**禁止写步骤**：

| 字段 | 是否必填 | 内容 |
|------|---------|------|
| 目标 | 是 | 一句话描述最终状态 |
| 验收信号 | 是 | 可测量的信号（测试数/lint 数/构建状态） |
| 范围边界 | 是 | 改哪些文件、不改哪些文件 |
| 约束 | 否 | 性能/兼容性/依赖限制 |

**反例（禁止）**：`/goal 先读 a.ts 再改 b.ts 然后跑测试` ← 这是写步骤

**正例**：`/goal 让 npm test 全绿，只改 src/ 目录，不改依赖版本`

### 示例

**示例 1：修测试失败**

```
/goal 让 pnpm test 全绿，只改 src/ 下文件，不引入新依赖
--stop testGate
--budget 150k
--max-rounds 15
```

**示例 2：补类型 + 过审核**

```
/goal 把 src/auth/ 下所有 any 替换为具体类型，通过 awkn-审核
--stop typecheckGate,reviewGate
--budget 200k
```

**示例 3：跑通完整质量门**

```
/goal 让 feature/login 分支通过全部 L2 默认门禁
--stop default
--budget 300k
--max-rounds 30
```

### 运行时模块职责

`runtime/commands/goal.ts`：

1. 解析意图，校验模板字段齐全
2. 加载停止条件集（default / 用户指定）
3. 初始化 Goal Loop 状态机
4. 调用 orchestrator 进入循环

---

## 三、/loop 命令

### 定位

控制正在跑的 Loop 的参数，或手动启动一个无目标的纯循环（少见）。

### 语法

```
/loop [--max-rounds <N>] [--budget <token>] [--interval <ms>] [--on-fail <action>]
```

### 参数

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `--max-rounds` | 20 | 最大轮数 |
| `--budget` | 200k | 总 token 预算 |
| `--interval` | 0 | 轮间隔，>0 时进入 L3 模式 |
| `--on-fail` | retry | gate 不通过时的动作：retry / pause / stop |

### 示例

**示例 1：限轮限预算**

```
/loop --max-rounds 10 --budget 100k
```

**示例 2：进入 L3 定时模式**

```
/loop --interval 60000 --max-rounds 100 --on-fail pause
```

**示例 3：失败即停**

```
/loop --on-fail stop --max-rounds 5
```

### 运行时模块职责

`runtime/commands/loop.ts`：

1. 读取当前 Loop 状态
2. 覆盖参数
3. 若 `--interval > 0`，转交 scheduler 进入 L3

---

## 四、/schedule 命令

### 定位

L3 入口。时间驱动触发 Loop，不依赖人工 /loop。

### 语法

```
/schedule <cron|interval> --goal <意图> [--stop <条件>] [--budget <token>]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| 触发表达式 | 是 | cron 字符串 或 `interval:<ms>` |
| `--goal` | 是 | 触发时跑的意图 |
| `--stop` | 否 | 停止条件，默认 L2 四项 |
| `--budget` | 否 | 单次触发预算，默认 100k |

### 示例

**示例 1：每 10 分钟巡检依赖**

```
/schedule interval:600000 --goal 检查 package.json 依赖是否有新版本，记录到 deps.log
--stop none
--budget 50k
```

**示例 2：每天凌晨跑测试**

```
/schedule "0 2 * * *" --goal 跑全量测试，失败发通知
--stop testGate
--budget 200k
```

**示例 3：每小时同步上游**

```
/schedule "0 * * * *" --goal 同步 upstream/main 到本地，无冲突则推送
--stop verificationGate
--budget 80k
```

### 运行时模块职责

`runtime/scheduler/schedule.ts`：

1. 注册 cron / interval 任务
2. 到点构造 Goal Loop 上下文
3. 调用 goal.ts 启动单次 Loop

---

## 五、/hook 命令

### 定位

注册同步短平快钩子。**铁律 3：hook 短平快，<200ms，重活下放 Skill**。

### 语法

```
/hook <event> <handler> [--blocking] [--timeout <ms>]
```

### 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| event | 是 | — | 钩子事件名 |
| handler | 是 | — | 处理函数标识（Skill 名 或 内联脚本路径） |
| `--blocking` | 否 | true | 是否同步阻塞 |
| `--timeout` | 否 | 200 | 超时毫秒数，硬上限 500 |

### 支持的事件

| 事件 | 触发时机 |
|------|---------|
| `pre-turn` | 每轮开始前 |
| `post-turn` | 每轮结束后 |
| `pre-gate` | 门禁执行前 |
| `post-gate` | 门禁执行后 |
| `on-fail` | gate 不通过时 |
| `on-stop` | Loop 停止时 |

### 短平快原则（强制）

| 原则 | 要求 |
|------|------|
| 执行时间 | < 200ms |
| 超时上限 | 500ms，超时即杀 |
| 禁止操作 | 网络 IO、大文件读写、子进程 spawn |
| 允许操作 | 读配置、改状态字段、记一行日志 |
| 重活下放 | 超过 200ms 的逻辑写成 Skill，hook 只触发 |

### 示例

**示例 1：每轮开始记一行日志**

```
/hook pre-turn scripts/log-turn.js --blocking --timeout 100
```

**示例 2：门禁失败时暂停**

```
/hook on-fail scripts/pause-loop.js --blocking
```

**示例 3：停止时发通知（轻量）**

```
/hook on-stop skills/notify-hook --timeout 200
```

### 运行时模块职责

`runtime/commands/hook.ts`：

1. 校验 handler 是否存在
2. 注册到事件总线
3. 触发时同步执行，超时强杀

---

## 六、/skill 命令

### 定位

加载并调用指定 Skill。Skill 是能力单元，沉淀"好"的标准（铁律 4）。

### 语法

```
/skill <skill-name> [--input <json|file>] [--async] [--budget <token>]
```

### 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| skill-name | 是 | — | 技能名，对应 skills/ 目录 |
| `--input` | 否 | stdin | 输入，JSON 字符串或文件路径 |
| `--async` | 否 | false | 是否异步执行 |
| `--budget` | 否 | 50k | 单次调用 token 预算 |

### 示例

**示例 1：同步调用执行检查**

```
/skill awkn-执行检查 --input '{"target":"src/auth/"}'
```

**示例 2：异步触发审核**

```
/skill awkn-审核 --input '{"diff":"HEAD~1"}' --async --budget 100k
```

**示例 3：调用复盘写回**

```
/skill awkn-复盘总结 --input '{"loopId":"loop-2026-07-09-001"}'
```

### 运行时模块职责

`runtime/commands/skill.ts`：

1. 按 skill-name 定位 skills/<name>/ 目录
2. 加载 SKILL.md 和入口脚本
3. 构造输入，执行，返回产出物

---

## 七、命令组合规则

| 组合 | 含义 |
|------|------|
| `/goal` → `/loop` | 启动 Goal Loop 后调整参数 |
| `/schedule` → `/goal` | 定时触发一个 Goal Loop |
| `/goal` → `/hook on-fail` → `/skill` | 失败时触发 Skill 处理 |
| `/skill` × N（在 Loop 内） | orchestrator 按 Skill 清单调度 |

**禁止组合**：

- `/goal` 嵌套 `/goal`：一个 Loop 一个目标
- `/hook` 调用 `/goal`：hook 不能起 Loop
- `/skill` 内部再 `/skill`：Skill 之间不互调，由 orchestrator 编排

---

## 八、命令返回值约定

| 退出码 | 含义 |
|-------|------|
| 0 | 成功 |
| 1 | 参数错误 |
| 2 | 预算耗尽 |
| 3 | 门禁不通过且达到 max-rounds |
| 4 | 用户主动停止 |
| 5 | 内部异常 |

每个命令结束时输出 JSON 摘要：`{cmd, status, rounds, tokensUsed, gatesPassed, exitCode}`。
