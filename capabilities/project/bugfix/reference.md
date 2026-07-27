---
name: awkn-bug修复大法
description: 证据驱动的 BUG 与发布故障闭环。接收 CICD/部署 FailureBundle，先复现或止损，再定位、修复和回归；FixBundle 必须回到 awkn-cicd 重跑质量门，禁止修完直接上线。
protection: 🟡
version: 2.0.0
author: AWKN
triggers:
  - keyword: bug修复
  - keyword: bug-fix
  - keyword: 排查bug
  - keyword: 复现问题
  - keyword: 修bug
  - keyword: 构建失败
  - keyword: 灰度失败
  - keyword: 上线故障
  - keyword: 回滚后异常
---

# awkn-bug修复大法 v2.0

## 一句话定位

本技能把 `awkn-cicd` 的质量门失败和 `awkn-部署` 的生产故障转换为可验证修复，并强制回到 CICD 重测：

```text
FailureBundle
  → Triage / Contain
  → Diagnose
  → Design
  → Execute
  → Regression Verify
  → FixBundle
  → awkn-cicd
```

共享契约见 [../awkn-部署/references/release-contract-v1.md](../awkn-部署/references/release-contract-v1.md)。

## 两类入口

### A. CICD 失败

来源包括 lint、typecheck、测试、安全门、迁移 dry-run、构建或产物验证失败。

默认顺序：复现 → 根因 → 修复 → 回归 → 回到 CICD。

### B. 部署/生产故障

来源包括远端预检、迁移、灰度、健康、全量或回滚失败。

默认顺序：止损 → 保存证据 → 根因 → 修复 → 回到 CICD。P0/P1 不等待完整诊断后才止损。

## 责任边界

| 本技能做 | 本技能不做 |
|---|---|
| 严重度与影响面判定 | 自行绕过 CICD 上线 |
| 生产故障止损建议与证据保护 | 把“重启好了”当根因 |
| 最小复现与可证伪假设 | 在原 release ID 中偷换产物 |
| 根因定位、修复设计和实现 | 直接打最终版本标签 |
| 回归测试与 FixBundle | 无授权修改生产配置/数据 |

## 输入：FailureBundle v1

最低输入：

- failure/release ID；
- 来源和失败阶段；
- 严重度；
- 期望与实际；
- 第一个坏信号时间；
- 日志、报告或指标证据；
- 相关 commit SHA；
- 已采取的止损动作。

若用户直接报 BUG 而没有 FailureBundle，先补齐这些字段的可用子集，不强迫用户填写完整表单。

## 严重度与优先顺序

| 级别 | 示例 | 第一动作 |
|---|---|---|
| `P0` | 全站不可用、数据持续损坏、安全事件 | 立即隔离/回滚/停写 |
| `P1` | 核心路径大面积失败、灰度指标恶化 | 停止晋级并切回健康版本 |
| `P2` | 局部功能错误、有替代路径 | 保留证据后正常修复 |
| `P3` | 低影响体验或日志问题 | 排期修复 |

止损属于部署技能的生产动作；本技能提出明确动作和证据要求，是否执行遵守既有授权。

## 5 阶段闭环

### Bug S0/5 — Triage / Contain

输出：

- 一句话现象与期望；
- 严重度、影响用户/环境和开始时间；
- 是否仍在扩大；
- 当前版本与上一健康版本；
- 最小止损动作；
- 已保存的日志、指标、请求 ID 和数据样本。

P0/P1 优先止损。禁止为了“抓更多日志”让故障继续扩大。

### Bug S1/5 — Reproduce

建立最小复现：

1. 固定 commit/release、环境、输入和前置状态；
2. 用单一可观察失败信号判定；
3. 能在 Windows 复现就不直接在生产试错；
4. 生产独有问题使用脱敏快照、影子环境或只读诊断；
5. 记录复现概率和对照组。

无法稳定复现时，转为时间线 + 差异诊断，不伪造确定性。

### Bug S2/5 — Diagnose

建立最多 3–5 个可证伪假设：

| 假设 | 支持证据 | 反证 | 最小实验 | 结果 |
|---|---|---|---|---|
| H1 | | | | |

按边界逐层检查：

- 变更 diff 与依赖；
- 配置、权限和环境差异；
- 构建产物与源码是否一致；
- 网络、缓存、并发和第三方；
- 数据 schema、迁移顺序和新旧版本兼容；
- Nginx/进程/端口/资源 Content-Type；
- 灰度流量和观测偏差。

根因必须解释“为何发生、为何此前没发现、为何该证据能排除其他假设”。

### Bug S3/5 — Design & Execute

至少比较：

- A：最小根因修复；
- B：更稳但影响面更大的修复；
- 兜底：隔离、关闭功能、回退或 forward-fix。

选择后记录：

- 改动文件和数据范围；
- 失败模式；
- 回滚/撤销方式；
- 新增回归测试；
- 是否影响迁移兼容、灰度阈值或部署标准。

修复必须创建新 commit；不得修改已经发布的不可变产物。

### Bug S4/5 — Regression Verify

在 Windows 本地至少执行：

1. 原始最小复现转为自动或可重复回归测试；
2. 修复前失败、修复后通过的证据；
3. 受影响模块测试；
4. lint/typecheck/构建；
5. 相关集成或关键 E2E；
6. 若涉及迁移，重新 dry-run 和兼容验证；
7. 检查没有扩大权限、泄露秘密或吞掉错误。

本阶段通过只说明“修复候选成立”，不等于允许上线。

### Bug S5/5 — FixBundle 与回流

输出 `FixBundle v1`：

- failure ID；
- 有证据的根因；
- 新 fix commit SHA；
- 变更文件；
- 回归命令 ID 与结果；
- 影响面和回滚说明；
- `next_state: RETEST_REQUIRED`。

FixBundle 唯一下游是 `awkn-cicd`。CICD 通过后生成新的 release ID 和新产物，再交给 `awkn-部署`。

## 反复失败破环

同类问题第二次出现时，不再只修症状，必须回答：

1. 为什么现有测试没拦住？
2. 为什么质量门或健康检查没观察到？
3. 为什么回滚/配置标准没有防住？
4. 哪个自动化检查可以更早失败？
5. 哪条项目部署标准或经验需要更新？

第三次出现时升级为系统性问题，要求修复防线而不只是业务代码。

## 热修规则

P0/P1 可以缩短，但不能绕开闭环：

```text
部署止损
  → 最小修复
  → 原问题回归
  → CICD 最小热修门
  → 新 ReleaseBundle
  → 部署灰度
  → 24 小时内补齐全量门与复盘
```

禁止使用“紧急”为理由直接复制文件覆盖生产或复用旧产物哈希。

## 安全与证据

- 日志、截图、转储和样本必须脱敏；
- 不把令牌、私钥、连接串或用户隐私写入 FailureBundle/FixBundle；
- 生产只读诊断优先，写操作需明确授权；
- 不删除原始证据；修复日志与原始日志分开；
- 时间统一记录时区；
- 结论区分事实、推断和未验证假设。

## 输出格式

```markdown
# BUG 修复结果

- Failure ID:
- Release ID:
- Severity:
- Source/Stage:
- Containment:

## Root cause
- Fact:
- Inference:
- Excluded hypotheses:

## Fix
- Fix commit:
- Changed files:
- Regression test:
- Result:

## Handoff
- FixBundle:
- Next: awkn-cicd
- Residual risk:
```

## 完成标准

- 故障已止损或复现范围已固定；
- 根因有证据且能解释现象；
- 修复创建了新 commit 和回归测试；
- FixBundle 已交给 CICD；
- CICD 重测通过后才允许部署；
- 生产问题在新版本灰度健康后才算真正关闭；
- 防复发规则已更新到测试门、部署标准或经验库。

## 与其他技能的关系

- 上游：`awkn-cicd`、`awkn-部署`、`awkn-审核`；
- 下游：仅 `awkn-cicd`；
- 执行实现：可调用 `awkn-工程师`；
- 复盘沉淀：`AWKN 复盘总结`。

## 版本历史

| 版本 | 日期 | 修改内容 |
|---|---|---|
| 2.0.0 | 2026-07-24 | 接入 FailureBundle/FixBundle；增加生产先止损、不可变产物约束和 CICD 强制回流，闭合构建失败与部署故障 |
