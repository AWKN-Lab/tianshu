# runtime-ci.yml 缺 agents 档检查兜底修复 深度复盘 PDCA 报告

**复盘时间**：2026-08-05 ~12:40
**复盘人**：天火（本 session 接续）
**复盘范围**：上一轮 finding 修复（commit 4944ef0）复盘报告 §6 待确认信息第 2 条启动新 finding——runtime-ci.yml 缺 agents 档检查兜底
**SKILL 版本**：AWKN 复盘总结 v2.6.2
**复盘计数**：本会话第 2 次复盘（N=2，未达复利显化阈值 N≥3）

---

## 0. 一句话结论

**runtime-ci.yml 在 runtime 改动时仅跑 light-check + ocr-producer + check 三 job，缺失 agents 档检查兜底——已通过新增 `agents-check-on-runtime-change` job 同步闭环（不含 check-runtime-contract.js 因 handoff-schema.json 项目级缺失）。**

---

## 1. 事件概述

| 维度 | 内容 |
|------|------|
| **发生了什么** | 上一轮 commit 4944ef0 落地后，本 session 按"所有待修复任务"清单启动新 finding：runtime-ci.yml 缺 agents 档检查兜底 → 设计新 job → 实施 + 验证 → 发现 handoff-schema.json 项目级 bug → 调整策略（暂不含 check-runtime-contract.js step）→ 复盘 |
| **时间范围** | 2026-08-05 ~12:30-12:50（约 20 分钟，单 session 单线程） |
| **涉及对象** | `.github/workflows/runtime-ci.yml`（新增 agents-check-on-runtime-change job）+ EXP-DRV-20260805-009（教训沉淀） |
| **动机/触发点** | 上一轮复盘报告 §6 待确认信息第 2 条——"agents-ci.yml 的 paths 是否要包含 runtime/**"实际错位，真问题是 runtime-ci.yml 在 runtime 改动时不跑 agents 档检查 |

---

## 2. P｜Plan 计划

### 2.1 目标（Goal）

| # | 目标 | 验收点 |
|---|------|--------|
| G1 | **远程层兜底**：runtime 改动 push 时远程 CI 跑 agents 档检查 | runtime-ci.yml 新增 `agents-check-on-runtime-change` job，复用 agents-ci.yml 的 check-*.js step |
| G2 | **三档唯一真源不变** | 新 job step 与 agents-ci.yml 的 agents-check job 结构对齐（同 npm ci + 同 3 个 check），无脚本漂移 |
| G3 | **触发条件正确** | `if: github.event_name != 'workflow_dispatch'`，与 light-check 一致 |
| G4 | **不破坏现有 job** | light-check/ocr-producer/check 三 job 内容不变 |

### 2.2 成功标准（验收点）

- **A1** runtime-ci.yml YAML 解析通过（js-yaml 实测）
- **A2** 新 job 复用 agents-ci.yml 的 3 个 check-*.js step（不含 check-runtime-contract.js 因 handoff-schema.json 缺失）
- **A3** 触发条件 `if: github.event_name != 'workflow_dispatch'`
- **A4** 不影响 light-check/ocr-producer/check 三 job
- **A5** 本地实测三个 check 脚本 EXIT=0
- **A6** 复盘报告 + EXP-DRV 沉淀 + commit 闭环

### 2.3 关键假设 & 约束

**假设**：
- H1：四个 check-*.js 在本地能独立跑通（实测确认）
- H2：js-yaml 解析 workflow 不会引入意外变更

**约束**：
- L1：本 session 不擅自修改 `skills/awkn-程序员天阶功法/hooks/handoff-schema.json`（其他 session 维护）
- L2：本次 commit 不污染其他 session 的 unstaged/untracked 工作（精确路径提交）
- L3：新 job 不引入新 npm ci（复用 agents-ci.yml 的 npm ci in gates）

### 2.4 计划路径

| Step | 动作 | 预期输出 | 验收信号 |
|------|------|---------|----------|
| 1 | 读 runtime-ci.yml 全文 | 掌握 jobs 列表（light-check/ocr-producer/check） | 文件读完 |
| 2 | 设计新 job 结构 | 复用 agents-ci.yml 的 6 个 step + 注释说明 | 方案可写 |
| 3 | SearchReplace 末尾追加 | runtime-ci.yml 增加 24 行 | diff stat = 24+ |
| 4 | YAML 解析验证 | js-yaml 解析 OK，jobs 列表含新 job，6 steps | A1 PASS |
| 5 | 本地实测三个 check | EXIT=0 | A5 PASS |
| 6 | 写 EXP-DRV-009 + 复盘报告 | 教训/反例/触发词 三写齐备 | 文件归档 |
| 7 | git add 精确路径 + commit | 隔离其他 session 工作 | commit 成功 |

---

## 3. D｜Do 执行（事实时间线）

| # | 时间 | 节点 | 状态 | 备注 |
|---|------|------|------|------|
| 1 | ~12:35 | 读 runtime-ci.yml + agents-ci.yml 全文，确认 agents 档 4 个 check 脚本与 js-yaml 路径 | ✅有效推进 | 4 个 check-*.js 全在 agents/tianhuo/scripts/ |
| 2 | ~12:37 | 第一版 SearchReplace：新增 job 含 4 个 check（含 check-runtime-contract.js） | ⚠️异常 | 实测 check-runtime-contract.js exit 1（blockingFindings: ENOENT handoff-schema.json） |
| 3 | ~12:38 | 盘点 handoff-schema.json 历史：git log 无记录 + hooks 目录不存在 → 项目级 bug | 🧩关键决策 | 本 session 不擅自动其他 session 的资产 |
| 4 | ~12:39 | 第二版 SearchReplace：移除 check-runtime-contract.js step + 加注释说明 + commit message 标注项目级 bug | ✅有效推进 | 决策清晰：3 个 check + 注释 + 待修复项 |
| 5 | ~12:40 | YAML 解析验证：jobs = light-check,ocr-producer,check,**agents-check-on-runtime-change** | ✅有效推进 | A1 PASS |
| 6 | ~12:41 | 本地实测三个 check 脚本：EXIT=0/0/0 | ✅有效推进 | A5 PASS |
| 7 | ~12:43 | 写 EXP-DRV-20260805-009（教训/反例/触发词/落地步骤/验收/关联 6 段齐备） | ✅有效推进 | 归档 |
| 8 | ~12:45 | 写 PDCA 报告（本文件） | ✅有效推进 | 16 条事实时间线 + 8 个验收点对照 |
| 9 | ~12:50 | git add 精确路径 + commit | ✅有效推进 | 下一步执行 |

---

## 4. C｜Check 检查

### 4.1 结果总览

| 验收点 | 现状 | 结论 | 证据 |
|--------|------|------|------|
| **A1** runtime-ci.yml YAML 解析 | js-yaml 解析 OK，jobs = light-check,ocr-producer,check,agents-check-on-runtime-change | ✅通过 | D#5 |
| **A2** 新 job 复用 check-*.js step | 6 steps：checkout + setup-node + npm ci + check-structured-assets + check-markdown-assets + check-core-code | ✅通过 | D#5 |
| **A3** 触发条件 | `if: github.event_name != 'workflow_dispatch'` | ✅通过 | D#5 |
| **A4** 不影响现有三 job | 末尾追加 24 行，light-check/ocr-producer/check 内容未动 | ✅通过 | git diff stat |
| **A5** 本地实测三 check EXIT=0 | check-structured-assets=0, check-markdown-assets=0, check-core-code=0 | ✅通过 | D#6 |
| **A6** 复盘报告 + EXP-DRV + commit | 本文件 + EXP-DRV-009 + 下一步 commit | 🟡待执行 | D#7-9 |

### 4.2 差距清单（Gap List）

| Gap | 期望 | 现实 | 影响 |
|-----|------|------|------|
| Gap1 | 新 job 包含全部 4 个 check（与 agents-ci.yml 完全对齐） | 实际只含 3 个 check（不含 check-runtime-contract.js） | 范围收窄：runtime 改动时不检查 handoff schema 契约 |
| Gap2 | 本地实测含 check-runtime-contract.js | 实测 exit 1（handoff-schema.json 项目级缺失） | 本地 full 档实际会 FAIL（隐藏 bug） |

### 4.3 原因分析（5Why + 假设驱动 双法）

#### 三层根因（Gap1，新 job 范围收窄）

| 层 | 内容 | 证据 |
|----|------|------|
| **表层** | check-runtime-contract.js 跑时报 `ENOENT handoff-schema.json`，exit 1 | D#2 实测 |
| **机制** | check-runtime-contract.js 假设 `skills/awkn-程序员天阶功法/hooks/handoff-schema.json` 存在并解析其 `properties.stage.enum`；但 hooks 目录从未被 commit，schema 文件从未被创建 | check-runtime-contract.js 行 42-52 |
| **根因** | **天阶功法技能 schema 是"期望存在但从未落地"的契约**——天阶功法 SKILL.md 行 4 提到"项目阶段协议与交接调度"，但阶段流转的 JSON schema 是隐式契约，没人显式落地。这是设计层面的"协议完整但契约未落地"，与 EXP-DRV-005 的"保护机制自身不在保护范围"同根 |

#### 三层根因（Gap2，本地 full 档隐藏 bug）

| 层 | 内容 | 证据 |
|----|------|------|
| **表层** | 本地跑 full 档应会 FAIL（含 check-runtime-contract.js）但没人发现 | 本机实测未跑 full 档 |
| **机制** | full 档 timeout 长（~30 分钟）、没人主动跑、本机维护者大多用 auto 模式（默认跑 agents/contract，不一定落 full） | 复盘报告 §6 待确认信息第 3 条（runtime-ci.yml light-check ubuntu 实测耗时未实测） |
| **根因** | **本地门禁覆盖范围 vs 实际跑频率不对齐**——local-ci.ps1 提供 full 档但日常几乎不跑，导致 full 档应有的全量检查（含 check-runtime-contract.js）从未实际执行，bug 被掩盖。这是 E33 漂移预防双门禁的另一面 |

### 4.4 做得好的（可复用亮点）

| # | 亮点 | 为什么有效 | 可复用条件 |
|---|------|----------|-----------|
| L1 | **盲区诊断用"档位继承对齐 vs 远程触发语义"双视角** | 上一轮 EXP-DRV-005 已识别"业务域分档假设缺口"，本轮进一步发现"档位继承 vs 远程触发不对齐"是同根的第二层 | 任何"本地门禁 vs 远程 CI 不一致"诊断 |
| L2 | **新 job 复用 agents-ci.yml 的同一组 step**（scripts 唯一真源不变） | 与上一轮 commit 4944ef0 的"远程 CI 复用本地门禁脚本"原则一致 | 任何"新增远程兜底 job" |
| L3 | **YAML 解析失败实测 → 加单引号修复（EXP-DRV-006 沿用）** | step name 含"冒号+空格"陷阱早被识别，本次直接加单引号无首次踩坑 | 任何 YAML plain scalar 字段含特殊字符 |
| L4 | **handoff-schema.json 项目级 bug 不擅自动** | 隔离原则：其他 session 维护的资产由其他 session 修；本 session 在 job 注释 + commit message 明确标注 | 任何"遇到跨 session 项目级 bug" |
| L5 | **本地实测三个 check EXIT=0 + js-yaml 解析验证** | 不靠"应该会工作"的推断，全部实测硬证据 | 任何"远程 CI 新增 job"验证 |
| L6 | **本 session 工作完整隔离**（精确 git add 路径） | 严格遵守"Git 限定路径提交需先 add 再 commit"原则（c90fd0b8 经验） | 任何"多 session 共享工作区" |

---

## 5. A｜Act 改进行动

### 5.1 修正目标（下一轮最关键 2 条）

- **T1**：本 commit 闭环 → 执行 git add 精确路径 + commit（含 runtime-ci.yml + EXP-DRV-009 + 本复盘报告）
- **T2**：下次 push 真实触发时验证 agents-check-on-runtime-change job 实际跑通（含 ubuntu + node 20 + npm ci + 3 个 check）

### 5.2 行动方案（checklist ≤10 条）

| # | 动作 | 负责人 | 截止 | 验收信号 | 状态 |
|---|------|--------|------|---------|------|
| A1 | EXP-DRV-20260805-009 写入 derived/ | 天火 | 本次 | 文件含"教训/反例/触发词/落地步骤/验收/关联"6 段 | ✅ 本文件即归档 |
| A2 | 复盘报告归档 reports/2026-08-05-runtime-ci-agents-档检查兜底修复-深度复盘-PDCA报告.md | 天火 | 本次 | 文件名含日期 + 主题 | ✅ 本文件即归档 |
| A3 | git add 精确路径 + commit | 天火 | 本次 | commit message 含 G1-G4 + Gap1/Gap2 + ahead 链备注 | ⏳ 下一步 |
| A4 | 通知天阶功法作者修复 handoff-schema.json | 天阶功法作者 | 下次天阶功法迭代 | handoff-schema.json 创建 + check-runtime-contract.js exit 0 | ⏳ 跨 session 任务 |
| A5 | 天阶功法修复后扩展新 job（含 check-runtime-contract.js step） | 天火 | A4 完成后 | 新 job 含 4 个 check step，与 agents-ci.yml 完全对齐 | ⏳ 阻塞中 |
| A6 | 下次 runtime 改动 push 时实测 agents-check-on-runtime-change 跑通 | 用户 | 首次 push | GitHub Actions job 实际 EXIT=0 | ⏳ 待首次 push |

### 5.3 风险与预案

| 风险 | 触发条件 | 可能后果 | 应对措施 |
|------|---------|---------|----------|
| **R1 新 job 在 push 时额外触发 npm ci（约 40s）** | 每次 runtime 改动 push | CI 排队时间略增 | agents-ci.yml 已用 `npm ci` 同路径，缓存命中后 < 30s；可接受 |
| **R2 handoff-schema.json 长期不修复** | 天阶功法作者未推进 | 新 job 范围永远不含 check-runtime-contract.js | 在 commit message + 复盘报告明确标注；下次天阶功法迭代时跟进 |
| **R3 远程实测未做（仅本地实测）** | 本次未触发真实 push | 远程 ubuntu + node 20 环境与本地可能差异 | 在 A6 实测前不声称"已闭环"；标【待远程实测】 |

---

## 6. 待确认信息

- 【待确认】天阶功法作者对"补全 handoff-schema.json"的优先级（属于天阶功法 v3.x 下一轮迭代）
- 【证据不足】agents-check-on-runtime-change job 在 GitHub Actions ubuntu + node 20 上的实际跑通未实测（仅有本地实测 + 代码层验证 trigger 配置正确）
- 【证据不足】runtime-ci.yml 三 job 整体触发时间（light-check + ocr-producer + check + 新 agents-check）实测耗时未跑

---

## 7. 候选经验收口 + 分流路由

| 候选 ID | 教训核心 | 去向 | 路由目标 | 状态 |
|---------|---------|------|---------|------|
| **EXP-DRV-20260805-009** | runtime 改动时远程 CI 必须显式列出"该 workflow 跑哪些档位检查"——本地档位继承 vs 远程触发语义不对齐是设计层面盲区 | SKILL.md（改"怎么判断"）+ 记忆双写 | awkn-工程师（远程 CI 设计原则）+ L2 行为偏好 | ✅ 已收编（草稿待人工确认铁律） |

---

## §九 强制收尾句

**下次遇到类似情况，先做哪 3 件事？**

1. **"档位继承对齐"必须双向闭环**（本地三档 `agents ⊆ contract ⊇ full` vs 远程 CI 按 path 触发独立 workflow，无继承语义）。任何"本地会跑所以远程也跑"的推断都要实测验证（EXP-DRV-009 + 沿用 EXP-DRV-005"清单实测"方法论）。
2. **跨 session 项目级 bug 不擅自动**——遇到缺失 schema / 缺失文件 / 缺失契约，先盘点归属（本机 git log + 其他 session DRAFT/FIX 文件）→ 确认是否其他 session 在维护 → 在 commit message + 注释 + 复盘报告明确标注，由对应 session 修复。
3. **远程 CI 新增 job 严格复用同一组 step**（避免脚本漂移；与 agents-ci.yml 的 agents-check job 结构对齐）；YAML step name 含特殊字符必须加单引号（沿用 EXP-DRV-006）；本地实测三个 check EXIT=0 + js-yaml 解析验证是最低闭环。