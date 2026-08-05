# Runtime 治理通道状态验证（Task 4）— 本 session 实测复现

**任务 ID**: task-4
**记录时间**: 2026-08-05 ~13:10
**记录人**: 天火（本 session）
**目标**: 验证 memory `72164c6c / f1e8ecb5`（"Runtime 治理通道状态实测修正"）列出的 3 条结论是否在本次 session 仍然成立

---

## 0. 一句话结论

**memory 3 条结论全部实测复现**：
1. ✅ cron 驱动层缺失：50+ 条 cron 全是健康检查、run_count=0、last_run_at=null
2. ✅ 格式层机制：扫描器按 marker 正则判定草稿，`**状态**: DRAFT` 不被识别
3. ✅ 通道层已恢复：MCP scan_drafts / cron_list 调用正常

**本 session 新增观察**（memory 未覆盖）：
- O1: corrections ledger **100% 是 loop_monitor source**（10 条全 open、0 resolved），无 evolve_scan / cron / agent_teams 等其他子系统 monitor
- O2: status=ACTIVE list 完全为空——corrections ledger 没有"已激活"语义区分

---

## 1. memory 3 条结论复现

### 1.1 结论 1: cron 驱动层缺失

**memory 原话**：
> 30+ 条 cron 全部为"每小时健康检查"且 run_count=0、last_run_at=null，无触发 awkn_evolve_scan_drafts 的调度配置

**本次实测**（`awkn_cron_list` 调用）：
- 返回 **50+ 条** cron 任务（仅返回前 50）
- 每条记录：**name = "每小时健康检查"**、**action_type = "http"**、action_payload 全部指向 `http://localhost:9000/health`、**cron_expr = "0 * * * *"**（每小时整点）、**last_run_at = null**、**run_count = 0**、enabled = 1
- 时间跨度：从 2026-07-29 16:17:13 到 2026-08-05 05:00:24（多条不同 created_at）
- 全部 50+ 条记录的 `name`、`action_type`、`cron_expr`、`run_count` 字段**完全相同**

**结论**：memory 表述完全准确。**没有任何一条 cron 触发 `awkn_evolve_scan_drafts` 或 `awkn_evolve_complete_drafts`**。`runtime HTTP port 9000` 也未实际监听（这是另一独立 bug，但本任务范围外）。

### 1.2 结论 2: 格式层机制已澄清

**memory 原话**：
> 扫描器 scanPendingDrafts 按正则 /待人工补充|待补全|待回放验证/ 统计 marker 数判定草稿，与状态字段（如 状态: DRAFT）无关，含 marker 的文件即被识别（如 EXP-DRV-20260805-004 被扫到而 001-003 未入列是因为无 marker）

**本次实测验证**：
- 用 `grep` 在 derived/ 目录搜 `待人工补充|待补全|待回放验证`：返回 **25+ 个匹配**（继续截断）
- 主要命中：
  - EXP-DRV-20260804-073/074/075/076/077/078/079/080（共 8 个不同 ID）均含 `**状态**: 待人工补充` + 章节 `## 4. 根因分析（待人工补充）` + `## 5. 待提炼的铁律（待人工补充）`
  - EXP-DRV-20260805-004 行 12 明确讨论"格式层"：扫描器只识别 `**状态**: 待人工补充` 格式，`状态: DRAFT` 不被识别
- **不命中的对照**：
  - EXP-DRV-20260805-009（本 session 创建的 DRAFT）：状态字段是 `**状态**: DRAFT`，未含三个 marker 词
  - EXP-DRV-20260805-005/006（本 session 升级为 ACTIVE）：状态字段是 `**状态**: ACTIVE`，更不含 marker
  - 故 005/006/009 **不在 scan_drafts 116 个返回列表里**——与 memory 结论一致

**结论**：memory 表述完全准确。`scan_drafts` 实质是"扫描器按 marker 正则挑选"，不是按状态字段。

### 1.3 结论 3: 通道层已恢复

**memory 原话**：
> 通道层已恢复（MCP scan_drafts 正常返回 116 条 pending），22:00 断连为当时状态

**本次实测**：
- `awkn_evolve_scan_drafts` 调用：✅ 正常，返回 116 条 pending，pendingMarkerCount 列表齐全
- `awkn_evolve_list`（无 status filter）：✅ 正常，返回 20+ 条 corrections
- `awkn_cron_list`：✅ 正常，返回 50+ 条 cron
- `awkn_evolve_stats`：✅ 正常，返回 loop_monitor statsBySource
- `awkn_evolve_detect`：✅ 正常，返回 detected pattern

**结论**：memory 表述完全准确。22:00 之后通道已完全恢复（无论是上次修复还是状态自愈，本 session 测得）。

---

## 2. 本 session 新增观察（memory 未覆盖）

### O1: corrections ledger source 单一性

**现象**：所有 corrections ledger 条目（≥20 条实样）**source 全部为 `loop_monitor`**，无任何 evolve_scan / agent_teams / cron / skill_executor 等其他子系统 monitor。

**验证**（`awkn_evolve_list` 返回 20 条原始数据观察）：
- 全部 `source: "loop_monitor"`
- 全部 `severity: "error"`
- 全部 `status: "open"`、`resolution: null`
- 全部 `experience_id: null`（无 EXP-DRV 关联！）
- 大量 fingerprint 重复出现（如 `829fa2294d439001` 出现 4 次、`547107604a58334d` 出现 2 次、`7d2fe9415e886e6c` 出现 2 次）

**stats 视角确认**（`awkn_evolve_stats`）：
- `statsBySource: [{source: "loop_monitor", total: 10, open: 10, resolved: 0}]`
- **整个 corrections ledger 仅 10 条**（loop_monitor 视角）
- resolved = 0 → 从未有任何 correction 被人工或自动 resolve

**潜在 bug 推论**：
1. **corrections ledger 设计上仅供 loop_monitor 上报**，其他子系统（evolve/cron/agent_teams）若出错，无通道上报
2. **`experience_id` 全部 null** → corrections ledger 与 EXP-DRV 经验库断连，corrections 永远不会被自动绑到经验沉淀，形成"错误一直累积但无人总结"的循环
3. **8/4 14:11-14:12 这 1 分钟内集中产生 14 条 corrections**（含 finger 重复），说明存在"loop 失控"事件从未被任何机制治理

### O2: status=ACTIVE 列表为空

**现象**：`awkn_evolve_list status=ACTIVE` 返回 `[]`（空数组）。

**推论**：
- corrections ledger 的 status 枚举实际仅含 `open / resolved`（来自原始数据观察）
- **`ACTIVE` 状态在 corrections ledger 不存在**——这是一个"语义错配"问题
- 用户/经验库视角的"DRAFT → ACTIVE" 流程（如本 session 对 EXP-DRV-005/006 的激活）**完全不在 corrections ledger 业务范围**

**实际意义**：
- 即使本 session 已 commit 9b28b1b 把 EXP-DRV-005/006 文档状态改为 ACTIVE
- corrections ledger 不会自动反映此变更（无双向同步机制）
- Runtime 通道视角**永远不知道**哪条经验已经激活、哪条还是 DRAFT
- 这是 EXP-DRV-004（三层断连验证法）的延伸观察——corrections ledger 本身**不是经验治理通道**

---

## 3. Task 4 完成清单

| # | 任务 | 状态 | 验收 |
|---|------|------|------|
| C1 | 调用 `awkn_evolve_scan_drafts` 看返回 | ✅ | 116 条 pending |
| C2 | 调用 `awkn_cron_list` 看 cron 列表 | ✅ | 50+ 条全是健康检查 0 run |
| C3 | 调用 `awkn_evolve_list` 看 corrections | ✅ | 全 loop_monitor source，10 条全 open |
| C4 | 调用 `awkn_evolve_list status=DRAFT/ACTIVE` 看空状态 | ✅ | ACTIVE 空；DRAFT 也是空（corrections 用 open/resolved） |
| C5 | Grep marker 正则确认 derived/ 命中情况 | ✅ | 25+ 命中 `待人工补充`；005/006/009 不命中 |
| C6 | 比对 memory `72164c6c / f1e8ecb5` 3 条结论 | ✅ | 全部复现 |
| **O1** | **新增观察：corrections source 单一性** | ✅ | 已分析（见 §2 O1） |
| **O2** | **新增观察：ACTIVE 列表空含义** | ✅ | 已分析（见 §2 O2） |
| **F1** | **Future：是否回写 memory 补充 O1/O2** | ⏳ | 待用户裁决；本 session 不擅自动 memory |

---

## 4. 与其他 Task / 风险的联动

### 4.1 Task 2（EXP-DRV-005/006 激活）联动

本 session Task 2 的"激活"是**文档字段层**（`**状态**: ACTIVE`），不是 corrections ledger 流程。两者**完全独立**：
- 文档层：9b28b1b 已 commit，005/006 文件首行 ACTIVE
- Runtime 层：corrections ledger 仍不感知（status=ACTIVE 列表空就是证据）

### 4.2 Task 1（commit 6d389d3）联动

R4 风险：EXP-DRV-009 仍 DRAFT。按本次验证看，EXP-DRV-009 即使推到仓库也不会被 Runtime 通道主动扫描评估（因为不含 marker）。所以 EXP-DRV-009 的"激活"只能走"实战触发 + 人工验证"路径（与 Task 2 的 005/006 走过的路径相同）。

### 4.3 R3 风险闭环

commit 4944ef0 R3（runtime-ci light-check ubuntu 耗时未实测）：本 session 通过 Task 3 部分闭环（本地基线层），剩余部分 Task 3b 阻塞——等首次 push 触发实测。

### 4.4 memory 更新建议（待用户裁决）

memory `72164c6c / f1e8ecb5` 表述准确，无须纠正。但可考虑：
- **追加 P1**：corrections ledger source 单一性（仅 loop_monitor）——不是 3 条结论的延伸，是新增独立观察
- **追加 P2**：status=ACTIVE 列表空的语义错配解释
- 任何追加都需用户裁决，本 session 不擅自动 memory

---

## 5. 风险与异常点

| 风险 | 触发条件 | 后果 | 缓解 |
|------|---------|------|------|
| **R-T4-1** corrections 持续累积无清理 | loop_monitor 不断上报新错误 | ledger 单调增大，无人治理 | P3 级别的"correction 清理"任务 |
| **R-T4-2** cron 健康检查从不真正运行 | cron.run_count=0 已成常态 | 端口 9000 若挂掉，无人发现 | R-T4-1 衍生；本地端口监听脚本可加 |
| **R-T4-3** scan_drafts 116 条 pending 持续无人补全 | 驱动层缺失（D1） | 经验沉淀永远积压在 L1，无法进入 L2/L3 | 需要 cron 调度器改造（独立任务） |

---

## §九 强制收尾句

**Task 4 本质是验证性质**：memory 已记录 3 条结论，本 session 再次实测全部复现。**结论 = memory 内容准确，本任务已闭环**。若用户希望补充 memory（加 O1/O2），需走 memory-update 流程，本 session 不擅自动。如果用户希望"修复"驱动层缺失（D1），那是新开 P0 任务（独立 cron 调度器改造），不是本任务范围。
