# 回放评测 token 阈值口径修复 — 深度复盘 PDCA 报告

**复盘时间**：2026-08-05 04:30（修复会话结束后）
**复盘触发**：`@复盘 深度复盘` + `/AWKN 复盘总结`
**复盘人**：天火
**复盘范围**：本次 fix token 阈值口径 session（2026-08-05 03:30 ~ 04:25，单 session）
**复盘框架**：深度复盘 模块 C（深分析 + PDCA）
**SKILL 版本**：AWKN 复盘总结 v2.5.4 / PDCA v1.0.0 / 10 步法 v1.0.0
**复盘计数**：本会话第 3 次复盘（N=3，**达到复利显化阈值**）

---

## 0. 一句话结论

**回放评测的 token 比值"硬门禁"会被候选规则文本自身的注入开销（system prompt 注入 CANDIDATE_ENGINEERING_RULE 块）单独裁决 QUARANTINED — 评测口径必须把"主门（成功率/错误率）"与"超限告警（token）"分离，否则等于"用自己的输入开销否决自己的输入"。**

---

## 1. 事件概述

| 维度 | 内容 |
|------|------|
| **发生了什么** | `/better-harness fix this issue`：把 [replay-evaluator.evaluate()](file://d:\awkn-lab\awkn引擎\runtime\src\evolve\replay-evaluator.ts) 中 token 比值硬门禁改为超限告警，主门（成功率/错误率等）决定 QUARANTINED/APPROVED 裁决；3 个生产 QUARANTINED 候选重跑验证裁决反转；`npm run check` 两次完整通过 |
| **时间范围** | 2026-08-05 03:30 ~ 04:25（约 55 分钟，单 session） |
| **涉及对象** | `runtime/src/evolve/replay-evaluator.ts`、`runtime/src/evolve/retrospective-bridge.ts`、`runtime/src/evolve/operational-evolution.ts`、`runtime/test/evolution-token-gate.test.ts`、生产 DB `awkn-engine.db`（3 个 QUARANTINED 候选 + 3 条 evolution_evaluations） |
| **动机/触发点** | 用户 @better-harness fix this issue 列出：① 评测留痕边界保持；② 裁决不再由规则注入开销单独决定；③ 在 runtime 跑 npm run check 不受影响；④ 重跑 QUARANTINED 候选的 promote 评测验证裁决反转 |

---

## 2. P｜Plan 计划

### 2.1 目标（Goal）

| # | 目标 | 验收点 |
|---|------|--------|
| G1 | **修源**：replay-evaluator 的 token 比值从"裁决性硬门禁"降级为"超限告警"，verdict 仅由主门（成功率/错误率/轮次/接管/安全违规）决定 | evaluate() 返回值含 warnings；reasons 不再含 'token cost regressed' |
| G2 | **保留痕**：evaluation 留痕边界保持（evolution_evaluations 表结构、delta_json、baseline/candidate metrics_json 不变） | evolution_evaluations.delta_json 保留 tokenCount delta；evaluation_json 新增 warnings 字段 |
| G3 | **传播一致**：PromoteCandidateResult 与 governCandidate 的 evaluation 参数透传 warnings | retrospective-bridge 返回 replayWarnings；operational-evolution 权威治理留痕含 warnings |
| G4 | **守门测试**：新增 3 用例覆盖（token 超限仅告警、主门回归仍 FAIL、留痕边界完整） | evolution-token-gate.test.ts 3/3 通过；既有 evolution 测试零回归 |
| G5 | **生产实测**：重跑生产库 3 个 QUARANTINED 候选（DB 副本 + 历史 metrics 重放） | 3/3 裁决 PASS + warnings 含 token 告警 + 状态 APPROVED |

### 2.2 成功标准（验收点）

- **A1**：replay-evaluator.evaluate() 返回值类型含 `warnings: string[]`；token 比值超标走 warnings 路径 ✅
- **A2**：token 比值 1.53（baseline 973/candidate 1492.67）+ successRate=1 + errorRate=0 → verdict=PASS + 状态 APPROVED ✅
- **A3**：successRate=0.5 + token 超标 → verdict=FAIL 且 reasons 不含 token；token 仍走 warnings ✅
- **A4**：evolution_evaluations.delta_json 保留 tokenCount delta（519.67）；evaluation_json 含 warnings 字段且 thresholds 原样 ✅
- **A5**：`npm run check` 连续两次完整通过（architecture → typecheck → lint → unit → contracts → verify 24/24）✅
- **A6**：生产 3 个 QUARANTINED 候选重跑，3/3 verdict=PASS + 状态 APPROVED + warnings 含 token 告警 ✅

### 2.3 关键假设 & 约束

**假设**：
- H1：修复不破坏既有 evolution 测试（evolution-auto-promotion / auto-rollback / operational-evolution / replay-evaluator）—— **事后验证通过**
- H2：production 3 个 QUARANTINED 候选在 DB 副本中能被 evaluate() 重新读取（QUARANTINED → VALIDATING 状态机合法）—— **事后验证通过**
- H3：历史 evolution_evaluations 中的 baseline/candidate metrics 是真实的"现成回放"输入（不需要真实 LLM）—— **事后验证成立**
- H4：`npm run check` 单次失败 = 偶发（与本修改无关）—— **事后两次全过证实**

**约束**：
- L1 不可改 evolution_evaluations 表结构（必须保留 delta_json 留痕）
- L2 不污染生产 DB（重跑必须用副本）
- L3 npm run check 命令路径与产物格式不变

### 2.4 计划路径

| Step | 动作 | 预期输出 | 验收信号 |
|------|------|---------|----------|
| 1 | 实证：grep DB 中 QUARANTINED 候选 + 看 evolution_evaluations | 3 条 FAIL 记录 reasons=["token cost regressed"] | delta_json tokenCount>0, successRate=1 |
| 2 | 定位：grep replay-evaluator.ts 中 token 判定代码 | `if (... > maxTokenRatio) reasons.push('token cost regressed')` 第 130 行 | 唯一裁决位置 |
| 3 | 修源：replay-evaluator.evaluate() token 移到 warnings + 返回结构加 warnings + evaluation 对象加 warnings 字段 | evaluate() 返回 `{verdict, baseline, candidate, reasons, warnings}` | TS 编译通过 |
| 4 | 透传：retrospective-bridge.PromoteCandidateResult 加 replayWarnings；operational-evolution.promote 的 governCandidate evaluation 加 warnings | 3 个返回点带 replayWarnings | npm run check:lint 通过 |
| 5 | 测试：新增 evolution-token-gate.test.ts 覆盖 3 场景 | 3 用例全过 | node --test 单测绿 |
| 6 | 守门：npm run check 完整跑两次 | exit 0 + verify 24/24 | $LASTEXITCODE=0 |
| 7 | 实战：DB 副本 + 历史 metrics 重放 3 候选 | 3/3 反转 + warnings 留痕 | 终态 status=APPROVED |

---

## 3. D｜Do 执行（事实时间线）

| # | 时间 | 节点 | 状态 | 备注 |
|---|------|------|------|------|
| 1 | 03:32 | Reading finding-bound-fix.md（@better-harness fix this issue 触发） | 🧩前置 | 因无 callback，按"最小 owner"思路直读 |
| 2 | 03:35 | Grep QUARANTINED/replay/token 在 runtime/src | 🔍定位 | 锁定 `runtime/src/evolve/replay-evaluator.ts` 与 `runtime/src/evolve/operational-evolution.ts` |
| 3 | 03:38 | Read replay-evaluator.ts 完整源码 | 🔍定位 | 第 130 行硬门禁确认 |
| 4 | 03:42 | Read operational-evolution.ts AgentReplayRunner.run() | 🔍定位 | 第 169-172 行 systemPrompt 注入 CANDIDATE_ENGINEERING_RULE 块 = 注入开销源头 |
| 5 | 03:45 | Read retrospective-bridge.ts promoteCandidateToEvolution | 🔍定位 | 留痕边界 + 返回结构 |
| 6 | 03:50 | Read lifecycle.ts saveEvaluation + 状态机 | 🔍定位 | ALLOWED: QUARANTINED → VALIDATING → APPROVED 合法 |
| 7 | 03:52 | Node 脚本查 awkn-engine.db 中 3 个 QUARANTINED 候选 | 📊实证 | 候选 23d54fdc/69ec575a/2939795f，successRate=1，reasons=["token cost regressed"] |
| 8 | 03:55 | 写 tmp-query-quarantined.cjs 查 baseline/candidate metrics | 📊实证 | token 比值 1.30/1.53/1.65，errorRate=0，无任何主门回归 |
| 9 | 04:00 | 修改 replay-evaluator.ts：token 超标移入 warnings；return 加 warnings | ✅有效推进 | diff: 5 行 +，3 行 - |
| 10 | 04:03 | 修改 retrospective-bridge.ts：PromoteCandidateResult 加 replayWarnings?；3 个返回点透传 | ✅有效推进 | diff: 7 行 +，0 行 - |
| 11 | 04:06 | 修改 operational-evolution.ts：governCandidate 的 evaluation 加 warnings 字段 | ✅有效推进 | diff: 1 行 + |
| 12 | 04:08 | 新增 evolution-token-gate.test.ts 3 用例 | ✅有效推进 | node --test 单测：25/25 全过（含既有 evolution 测试） |
| 13 | 04:12 | npm run check 第一次：exit 1（疑 PowerShell 退出码传播偶发） | ⚠️异常 | 分步单跑 arch/typecheck/lint/test/test:contracts/test:verify 各自 exit 0 |
| 14 | 04:14 | npm run check 第二次：exit 0，verify 24/24 | ✅有效推进 | 第一次 exit 1 与本修改无关（分步全过） |
| 15 | 04:14 | npm run check 第三次（稳定性验证）：exit 0 | ✅有效推进 | 排除 flaky |
| 16 | 04:18 | 写 tmp-rerun-quarantined.ts：复制 DB → 隔离副本 + 历史 metrics 重放 | ✅有效推进 | DB 副本 tmpdir，结束 rm |
| 17 | 04:22 | 重跑 3 个 QUARANTINED 候选 | ✅有效推进 | 3/3 verdict=PASS, status=APPROVED, warnings 含 token 告警, deltaTokenCount 519.67/603.33/312 |
| 18 | 04:24 | 清理 tmp-rerun-quarantined.ts / tmp-query-quarantined.cjs / tmp-check-*.log | ✅收口 | data/ 与 scripts/ 临时文件全清 |

---

## 4. C｜Check 检查

### 4.1 结果总览

**目标达成情况**：G1~G5 全部达成

| 验收点 | 现状 | 结论 | 证据 |
|--------|------|------|------|
| **A1** evaluate() 返回含 warnings，reasons 不含 token | 成立 | ✅通过 | D#9 diff + A4 测试 |
| **A2** token 1.53 + successRate=1 + errorRate=0 → PASS + APPROVED | 成立 | ✅通过 | A5 verify (verdict=PASS, status=APPROVED) |
| **A3** successRate=0.5 + token 超标 → FAIL 且 reasons 不含 token | 成立 | ✅通过 | evolution-token-gate.test.ts:60-80 |
| **A4** delta_json 保留 tokenCount delta + evaluation 含 warnings + thresholds 原样 | 成立 | ✅通过 | evolution-token-gate.test.ts:85-108 |
| **A5** npm run check 连续两次完整通过 | 成立 | ✅通过 | D#14-15 |
| **A6** 3 个 QUARANTINED 候选 3/3 反转 | 成立 | ✅通过 | D#17 表格 |

### 4.2 差距清单（Gap List）

| Gap | 期望 | 现实 | 影响 |
|-----|------|------|------|
| Gap1 | npm run check 单次跑 = 退出码稳定 | 第一次 exit 1（PowerShell 重定向偶发），第二次/第三次 exit 0 | 单次不可信必须重跑；分步单跑全 exit 0 证实与修改无关 |
| Gap2 | 旧代码 reasons 文案 'token cost regressed' 被 grep 替换为 'token cost exceeded warning ratio' | 任何代码 grep 旧文案将无匹配 | 文档/下游若有依赖旧文案须更新（本次无外部依赖） |
| Gap3 | 远端权威治理（governCandidate）实际接收到 warnings 字段 | 仅做接口留痕（operational-evolution.ts 第 315 行），未实测远端 MCP 调用 | 若远端 authority 严格 schema 校验则需补充；当前 memory/backend router 接收 `Record<string, unknown>` 兼容 |
| Gap4 | 3 个 QUARANTINED 候选的真实状态升级未持久化到生产 DB | 仅在 DB 副本完成验证，生产 DB 仍为 QUARANTINED | 本次范围为 fix 评测口径；激活走 evolution-cli.ts 的 promote 命令 + 用户授权 |

### 4.3 原因分析（假设驱动 + 5Why 双法）

#### 假设验证矩阵

| 假设 | 证据 | 验证结果 |
|------|------|----------|
| **H1** 修复不破坏既有 evolution 测试 | node --test 5 个 evolution 文件 25/25 | ✅ 通过 |
| **H2** production 3 候选在 DB 副本中可被 evaluate() 重读 | lifecycle.ALLOWED[QUARANTINED] 含 VALIDATING | ✅ 通过 |
| **H3** 历史 baseline/candidate metrics 是真实可重放输入 | node 脚本读取 + 重放成功 | ✅ 通过 |
| **H4** npm run check 第一次 exit 1 = 偶发 | 分步单跑 exit 0 + 第二次/第三次 exit 0 | ✅ 通过 |

#### 三层根因（5Why 链：为何 token 会成为硬门禁？）

| 层 | 内容 | 证据 |
|----|------|------|
| **表层** | replay-evaluator 第 130 行 `reasons.push('token cost regressed')` 单独裁决 | D#3 |
| **机制** | EvaluationThresholds 把 maxTokenRatio 与其他门禁并列，全部 push 进 reasons → any 一个 push = FAIL | D#3 第 128-134 行 |
| **设计假设** | 把"成本指标"与"质量指标"放在同一裁决向量，隐含"token 是质量信号" | DEFAULT_THRESHOLDS 把 maxTokenRatio=1.1 与 minSuccessDelta 并列 |
| **根因** | **未区分"主门"与"告警"两类信号**。质量类指标（successRate/errorRate/security）应当决定 PASS/FAIL；成本类指标（token/cycles）应当可观测但不裁决。Design assumption 缺乏"门禁分级"约束 | 现有 6 个门禁中 token 与 cycle 是"成本性"，其他 4 个是"质量性"，未分类 |
| **设计影响** | AgentReplayRunner 第 170 行 systemPrompt 注入 CANDIDATE_ENGINEERING_RULE 块 → 候选侧 token 必然高于 baseline → 任何候选规则的 token 比值都 ≥ baseline + rule 文本固定开销 ÷ N turns → 几乎必然超 1.1 | operational-evolution.ts:169-172 |

### 4.4 做得好的（可复用亮点）

| # | 亮点 | 为什么有效 | 可复用条件 |
|---|------|----------|-----------|
| L1 | **DB 副本隔离重放**（D#16-17）用历史 baseline/candidate metrics 替代真实 LLM 调用 | 既零成本又零依赖；用生产真实数据验证修复边界 | 任何"评测口径"修复的验证 |
| L2 | **把 token 与主门分类**（4.3 根因层）而不是简单注释"这是注入开销" | 留痕（warnings）+ 不裁决 + 接口透传三层一致 | 任何包含成本指标的评测系统设计 |
| L3 | **回归测试既测成功路径也测留痕边界**（A4 第 3 用例） | 不只验 verdict，验 baseline_metrics_json/candidate_metrics_json/evaluation_json 三列 JSON 都符合预期 | 任何涉及 DB 留痕的修复 |
| L4 | **npm run check 第一次失败时分步单跑定位**（D#13） | 立即排除"修改引入"的怀疑，转向"PowerShell 重定向偶发"假设 | 任何 CI 偶发失败 |
| L5 | **modify 时把"为什么"写在代码注释里**（replay-evaluator.ts 第 134-137 行注释） | 解释"为何 token 不进 reasons"而非仅改逻辑 | 任何"违反原设计"的修复 |

---

## 5. A｜Act 改进行动

### 5.1 修正目标（下一轮最关键 2 条）

- **T1**：把"门禁分级"（主门 vs 告警）固化成 [EvaluationThresholds 设计原则](file://d:\awkn-lab\awkn引擎\runtime\src\evolve\replay-evaluator.ts) 注释 + 配套断言测试 — 防止同类问题再次发生（任何"成本性"指标被错误升级为"质量性"门禁）
- **T2**：把"评测口径修复的标准验证法"（DB 副本 + 历史 metrics 重放）固化成 [evolution-token-gate.test.ts](file://d:\awkn-lab\awkn引擎\runtime\test\evolution-token-gate.test.ts) 模板 — 复用于 cycle/security 等其他可能含注入开销的指标

### 5.2 行动方案（checklist ≤10 条）

| # | 动作 | 负责人 | 截止 | 验收信号 | 状态 |
|---|------|--------|------|---------|------|
| A1 | EXP-DRV-20260805-005（门禁分级：主门 vs 告警）→ 路由到 replay-evaluator.ts 注释 + 评测系统设计原则 | 天火 | 2026-08-06 | 文件头注释含"主门 vs 告警"二分类 + 配套测试 | ✅ 已落注释（本 fix 内），EXP 候选 DRAFT |
| A2 | EXP-DRV-20260805-006（DB 副本 + 历史 metrics 重放验证法）→ 路由到 evolution-token-gate.test.ts 模板 | 天火 | 2026-08-06 | 模板可被 cycle/security 等其他门禁修复复用 | ✅ 已落模板（本测试文件），EXP 候选 DRAFT |
| A3 | 把本 PDCA 报告归档到 `agents/tianhuo/04-记忆与知识/EXPERIENCE/reports/` | 天火 | 本次会话内 | 文件名含日期 + "token阈值口径修复" | ✅ 本文件即归档 |
| A4 | 提交本次 fix 到 git（replay-evaluator/retrospective-bridge/operational-evolution + test + report） | 用户授权后 | T+1d | commit message 含 "fix(token-gate): token 仅作超限告警" + ahead chain 备注 | ⏳ 待用户授权 |
| A5 | 激活 3 个生产 QUARANTINED 候选（evolution-cli promote） | 用户授权后 | T+1d | 3 个候选 status: QUARANTINED → APPROVED → ACTIVE | ⏳ 待用户授权 + 远端治理通道实测 |
| A6 | 把"主门 vs 告警"原则回写到 Runtime 治理通道（governance/evaluate 路径） | 天火 | 后续 | governance 留痕含 warnings 字段 | ⏳ 待 governance 模块读图 |

### 5.3 风险与预案

| 风险 | 触发条件 | 可能后果 | 应对措施 |
|------|---------|---------|----------|
| **R1 cycle/security 等其他门禁也有类似注入开销** | 候选侧 metrics 含规则注入的系统性偏差 | 下次某个候选仍被错误裁决 | 套用同模板（DB 副本 + 历史 metrics）逐个门禁做"门禁分级"复审 |
| **R2 远端 authority 严格 schema 校验 warnings 字段** | governance backend 升级或 schema 收紧 | governCandidate 调用被拒 | 在 governance backend 添加 warnings 字段白名单 + 走 backward-compatible 路径 |
| **R3 3 个 QUARANTINED 候选重激活触发 active_memory publish** | activate → publishEngineeringMemory 推回 Memory OS | Memory OS 包含历史失效规则 | 重激活前先 deactivate 上一 ACTIVE 或先 audit experience_id 关联链 |
| **R4 EXP-DRV 候选未激活** | Runtime 治理通道延续失效 | DRAFT 候选永远停在 DRAFT | 不依赖 MCP 激活；走人工路由（已在 A1-A2 注释/模板上落）+ 用户确认 |

---

## 6. 待确认信息

- 【待确认】远端 authority backend 是否严格 schema 校验 `warnings` 字段（需实测一次 governCandidate 调用）
- 【待确认】3 个生产 QUARANTINED 候选（23d54fdc/69ec575a/2939795f）是否需要人工重新激活（QUARANTINED → APPROVED → ACTIVE）
- 【待确认】本次修复是否需要 backport 到旧分支（runtime 当前分支版本）
- 【证据不足】本 PDCA 是基于本次单 session 时间线 + DB 留痕的完整归纳，未调 subagent 重取证（按 SKILL 原则 17 不触发对账门禁）

---

## 7. 候选经验收口 + 分流路由

| 候选 ID | 教训核心 | 去向 | 路由目标 | 状态 |
|---------|---------|------|---------|------|
| **EXP-DRV-20260805-005** | 评测系统的门禁必须二分类：主门（质量性，决定 verdict）vs 告警（成本性，仅留痕） | SKILL.md（改"怎么设计评测"） | runtime/src/evolve/replay-evaluator.ts 头注释 + 通用评测设计原则 | ✅ 已收编注释，EXP 候选 DRAFT（待 Runtime 激活） |
| **EXP-DRV-20260805-006** | 评测口径修复的标准验证法 = DB 副本 + 历史 metrics 重放（零 LLM 依赖） | 测试模板（改"怎么验证修复"） | runtime/test/evolution-token-gate.test.ts 模板 + 通用修复验证法 | ✅ 已落模板，EXP 候选 DRAFT（待 Runtime 激活） |

---

## §九 强制收尾句

**下次遇到类似情况（"评测系统某指标把不该裁决的项裁决了"），先做哪 3 件事？**

1. **生产 DB 实证门禁是"唯一裁决因素"还是"叠加因素"** —— 用 `SELECT json_extract(candidate_json,'$.successRate') AS cSuc, json_extract(candidate_json,'$.errorRate') AS cErr, json_extract(delta_json,'$.tokenCount') AS dTok FROM evolution_evaluations WHERE verdict='FAIL'` 找到 successRate=1/errorRate=0/仅 tokenCount>0 的"纯门禁裁决"案例，确认修复必要性（EXP-DRV-005 / A1）。
2. **门禁分级：主门（质量性）vs 告警（成本性）** —— 任何评测系统设计前先做二分类：successRate/errorRate/securityViolationRate 决定 verdict；token/cycles 仅留痕不裁决。改一处不影响其他 5 处门禁，避免大改回归（EXP-DRV-005）。
3. **修复验证用 DB 副本 + 历史 metrics 重放** —— 不调 LLM、不污染生产 DB、不需要 mock runner。用 `cp awkn-engine.db tmp.db; AWKN_DB_PATH=tmp.db npx tsx scripts/rerun.ts` 三步完成零成本验证（EXP-DRV-006 / A2）。