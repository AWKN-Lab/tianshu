# runtime-ci light-check ubuntu 实测耗时 — 基线 + 实测跟踪

**任务 ID**: task-3
**记录时间**: 2026-08-05 ~13:00
**记录人**: 天火（本 session）
**目标**: 获取 runtime-ci.yml `light-check` job 在 GitHub Actions ubuntu-latest runner 上的真实耗时数据

---

## 0. 一句话结论

**本 session 内仅能完成本地基线测量；GitHub Actions ubuntu-latest 实测必须在首次 runtime 改动 push 后由 GitHub Actions UI / gh CLI 抓取。本任务当前已 ⏳ 部分完成（基线层），首次 push 实测为 ⏳ 阻塞项。**

---

## 1. light-check job 内容（runtime-ci.yml 行 27-43）

```yaml
light-check:
  if: github.event_name != 'workflow_dispatch'
  runs-on: ubuntu-latest
  timeout-minutes: 10
  defaults:
    run:
      working-directory: runtime
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
        cache-dependency-path: runtime/package-lock.json
    - run: npm ci
    - name: 'Light gate: TypeScript typecheck (contract 档核心)'
      run: npm run typecheck
```

实质：4 个 step（checkout + setup-node(w/ cache npm) + npm ci + tsc --noEmit）。

---

## 2. 本地基线数据（2026-08-05 实测）

| 步骤 | 本地实测（Windows node 24 / npm 11.16 / PowerShell） | 命令 |
|------|-------------------------------------------|------|
| `npm run typecheck`（= `tsc --noEmit`） | **17.34 秒** | `Measure-Command { npm run typecheck }` |
| `npm ci --no-audit --prefer-offline`（cache hit） | **6.07 秒**（4885 个 node_modules 文件已就位） | `Measure-Command { npm ci --no-audit --prefer-offline }` |
| 本机 node/npm 版本 | node v24.18.0 / npm 11.16.0 | `node --version && npm --version` |

**本地等价总耗时 = 17.34 + 6.07 = 23.41 秒**（不计 checkout/setup-node 等 runner 阶段）。

⚠️ **注意差异**：
- 本机 **Windows** PowerShell 7 + node **24**；GitHub Actions ubuntu-latest runner 是 **Linux ubuntu-22** + node **20**
- tsc 增量编译在 ubuntu 上通常比 Windows node 24 略快（Linux fs 更优）
- 但 npm ci 在 Ubuntu cold start 会显著慢（无本地缓存，需 setup-node 先下载/构建依赖）

---

## 3. GitHub Actions ubuntu-latest 估算（cache hit / miss 两场景）

### 3.1 cache hit 场景（典型日常 push 增量改动）

| Step | 估算耗时 | 备注 |
|------|---------|------|
| actions/checkout@v4 | ~3s | 标准 LFS handler |
| actions/setup-node@v4 w/ cache npm | ~5s | 缓存命中，仅消费 |
| npm ci | ~20-30s | 增量 build，非全量 |
| npm run typecheck | ~15-20s | tsc 增量编译 |
| **总耗时** | **~50-60 秒** | R2 估算 ~40s 略乐观，实际更接近 50s |

### 3.2 cache miss 场景（runner 首次冷启动 / 缓存失效）

| Step | 估算耗时 | 备注 |
|------|---------|------|
| actions/checkout@v4 | ~5s | 标准 |
| actions/setup-node@v4 w/ cache npm | ~20-30s | 下载 + 解压 npm 缓存 |
| npm ci（全量安装） | ~60-90s | 全部 deps 从 cache 解包 + build 链接 |
| npm run typecheck | ~25-30s | 无 tsc 缓存冷编译 |
| **总耗时** | **~120-150 秒（2-2.5 分钟）** | 1 次冷启动后再热启动变快 |

### 3.3 timeout-minutes: 10 = 风险边界

当前 timeout = 10 分钟 = 600 秒。1 次冷启动 + 容错充裕。但若 runtime 改动大规模导致 tsc 重编译（>500 文件改动），可能接近 5-8 分钟，需监控。

---

## 4. 首次 push 后实测 checklist（Task 3b 执行步骤）

**前置条件**：本 session 内 commit 6d389d3（agent-check-on-runtime-change job） + 已有 ahead 链 4 commit，必须 push 才能触发 light-check 实测。

### 4.1 实测触发方式

| 方式 | 命令 | 适用场景 |
|------|------|----------|
| **A. 用户 push 真实代码改动** | `git push tianshu main` | 最贴近真实场景，cache miss → hit 完整序列 |
| **B. gh CLI 触发 workflow_dispatch** | `gh workflow run runtime-ci.yml` | 不触发 light-check（if 条件跳过），仅触发 ocr-producer + check + agents-check |
| **C. 空触发 PR** | 提交一条无关文件 commit → push → 触发 light-check | 同 A，最贴近 |

**结论**：必须用 A 或 C，B 不能拿到 light-check 数据。

### 4.2 抓取实测耗时数据

#### 方式 1: GitHub Actions UI
1. push 后访问 https://github.com/tianshu/awkn/actions
2. 选择最新一次 `runtime-ci / light-check` run
3. 点入查看每个 step 的实际耗时（显示在 step 名称右侧）

#### 方式 2: gh CLI（推荐，机器可读）
```bash
# 列出最近 5 次 runtime-ci run
gh run list --workflow=runtime-ci.yml --limit 5

# 查看指定 run 的所有 job + step 耗时
gh run view <RUN_ID> --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, startedAt: .startedAt, completedAt: .completedAt, steps: (.steps[] | {name: .name, conclusion: .conclusion, duration_ms: ((.completedAt // now) | fromdate) - (.startedAt | fromdate)})}'

# 简单总耗时
gh run view <RUN_ID> --json createdAt,updatedAt,conclusion
```

### 4.3 实测数据记录格式（首次 push 后填写本节）

```yaml
实测时间: ____-__-__ ~__:__
push commit: _____ (含 ____ 改动行数 / ____ 个 .ts 文件)
trigger: [真实 push / 空触发 PR]

light-check 总耗时: __ 秒
  - actions/checkout@v4: __ 秒
  - actions/setup-node@v4 w/ cache: __ 秒
  - npm ci: __ 秒
  - npm run typecheck: __ 秒

cache 命中状态: [hit / miss / partial]
runner: ubuntu-latest, runner-image: ____
node: 20.x.x

实测对比估算 (R2 ~40s / 实测 __s):
- 偏差 __% → 说明（命中率/冷启动差异/etc）
```

### 4.4 实测后决策树

| 实测结果 | 决策 |
|---------|------|
| light-check 总耗时 < 60s | R2 风险可控，无需调整 |
| 60s ≤ 总耗时 < 120s | 接受，加 commit message 备注"首次实测 X 秒" |
| 120s ≤ 总耗时 < 300s | 需考虑：是否拆 checkout（如 lfs-only）、是否 cache build artefacts、是否 tsc --incremental |
| 总耗时 ≥ 300s | timeout 风险，必须优化；可能需新增 path 过滤排除 docs 改动 |

---

## 5. 本 session 完成 + 未完成清单

| # | 任务 | 状态 | 验收 |
|---|------|------|------|
| L1 | runtime-ci.yml light-check 步骤拆解 | ✅ | 行 27-43 |
| L2 | 本机 typecheck 耗时基线 | ✅ | 17.34 秒 |
| L3 | 本机 npm ci 耗时基线 | ✅ | 6.07 秒 |
| L4 | GitHub Actions cache hit / miss 估算 | ✅ | hit ~50-60s, miss ~120-150s |
| L5 | 首次 push 后实测 checklist | ✅ | §4.1-4.4 |
| L6 | R2 风险评估修正 | ✅ | R2 估算偏乐观，实测应 > 40s |
| **U1** | **首次 push 真实实测 GitHub Actions 数据** | ⏳ **阻塞** | 需用户 push 触发，本 session 无法进行 |
| **U2** | **Task 3b：ubuntu 实测最终报告 + Task 1 R3 闭环联动** | ⏳ **阻塞** | U1 完成后执行 |

---

## 6. 与其他 Task 联动

### 6.1 Task 1（commit 6d389d3）联动

`agents-check-on-runtime-change` job 同样 runs-on ubuntu-latest，会与 light-check 并行触发。首次 push 后除测 light-check 外，必须测：
- agents-check-on-runtime-change 总耗时
- 该 job 的 npm ci（agents/tianhuo/gates 子目录）是否触发
- 3 个 check-*.js step 各自耗时

### 6.2 Task 4（Runtime 治理通道状态验证）联动

Runtime 通道当前 corrections ledger 全是 loop_monitor 错误记录，**没有 EXP-DRV 关联条目**（见 Task 4 输出）。这意味着即使 light-check 实测通过，也无人自动把"R3 实测通过"信号回写到 EXP-DRV-009 的激活记录——仍是半人工流程。

### 6.3 R3 / R4 风险闭环

- R3（commit 4944ef0）—— runtime-ci light-check 耗时未实测：本次 Task 3 解决基线部分，U1 解决实测部分
- R4（commit 4944ef0 / 6d389d3）—— EXP-DRV-005/006/009 DRAFT 待激活：Task 2 已闭环 005/006，009 仍 DRAFT 待 Task 3 联动的 R3 闭环后激活

---

## §九 强制收尾句

**本任务的"实测"环节不能在本机完成**，必须等用户在 tianshu 仓库 push 含 runtime 改动的 commit（或新建 PR）触发 GitHub Actions light-check，然后通过 GitHub Actions UI / gh CLI 抓取真实耗时数据填入 §4.3 记录模板。本 session 留本跟踪文档（含基线 + 估算 + 实测 checklist + 验证决策树）作为下游实测的操作手册。
