---
name: awkn-审核
protection: 🔴
displayName: "AWKN 审核"
description: "DSPRBSE Review 阶段唯一执行者。工程级审核：代码审查+QA测试+安全扫描+AI代码审查(prompt注入/幻觉/模型安全)+供应链安全(SBOM/容器/IaC)+审核工程化(SLA/变异测试/性能回归/模式库)+125子技能库。触发词：审核、代码审查、review、QA、测试验收、安全审查、发布前检查、质量门禁、AI审查、供应链安全"
aliases: ["审核", "代码审查", "review", "QA", "测试验收", "安全审查", "发布前检查", "是否可以上线", "质量门禁", "vulnerability-scanner", "security-scanning", "SAST", "漏洞扫描", "静态安全测试", "AI审查", "供应链安全", "SBOM", "变异测试"]
version: v4.1.1
dspbrbse-phase: Review
category: 质量保障
tags: ["review", "qa", "security", "verification", "tdd", "refactoring", "vulnerability-scanning", "sast-analysis", "ai-code-review", "supply-chain", "mutation-testing", "performance-regression", "review-engineering"]
triggers:
  - keyword: "审核"
    description: "用户需要审核代码或产品质量"
  - keyword: "代码审查"
    description: "用户需要做代码审查或PR审查"
  - keyword: "review"
    description: "英文触发词，代码审查"
  - keyword: "QA"
    description: "用户需要做质量保证测试"
  - keyword: "测试验收"
    description: "用户需要做测试验收或冒烟测试"
  - keyword: "安全审查"
    description: "用户需要做安全扫描或安全审查"
  - keyword: "发布前检查"
    description: "用户需要确认是否可以上线"
  - keyword: "质量门禁"
    description: "用户需要设置或通过质量门禁"
  - keyword: "TDD"
    description: "用户需要测试驱动开发"
  - keyword: "漏洞扫描"
    description: "用户需要漏洞扫描或漏洞分析"
  - keyword: "SAST"
    description: "用户需要静态应用安全测试"
  - keyword: "AI审查"
    description: "用户需要AI代码审查(prompt注入/幻觉/模型安全)"
  - keyword: "供应链安全"
    description: "用户需要供应链安全审查(SBOM/容器/IaC)"
  - keyword: "变异测试"
    description: "用户需要变异测试审查"
  - keyword: "性能回归"
    description: "用户需要性能回归检测"
capabilities:
  - code-review
  - qa-testing
  - security-scanning
  - verification
  - tdd
  - refactoring
  - vulnerability-scanning
  - sast-analysis
  - verification-gate（references/verification-gate/）：实施后只读验证，检查完成声明是否真实
  - ai-code-review
  - supply-chain-security
  - review-engineering
  - mutation-testing
  - performance-regression
  - mcp-builder（skills/mcp-tools/mcp-builder/）：MCP Server 创建指南
  - mcp-management（skills/mcp-tools/mcp-management/）：MCP 服务器管理与工具调度
memory-integration:
  - 审核结论写回：审核通过/打回/升级结论存入记忆系统，供后续阶段参考
  - 记忆系统路径：C:\Users\10919\Desktop\AWKN-Lab\记忆系统\
---

# AWKN 审核 v4.1.0

> DSPRBSE **Review 阶段唯一执行者** — 工程级审核体系
> **v4.1.0 新增**: Meta-review 协议 — 审查审查者的标准（断言覆盖度/断言强度/历史一致性/Weak PASS检测）
> **v4.0.0 新增**: AI代码审查(prompt注入/幻觉/模型安全) + 供应链安全(SBOM/容器/IaC) + 审核工程化(SLA/变异测试/性能回归/跨项目模式库)

## 边界定义

```
✅ 我做:                                ❌ 我不做:
代码审查与质量保障                        需求定义（awkn-prd）
QA测试验收                               UI/UX设计（awkn-ui）
安全扫描与密钥泄露检测                     正式部署执行（awkn-部署）
发布前质量门禁                            流程调度（天阶功法）
AI代码审查 (v4.0)                         CI/CD流水线执行（awkn-cicd）
供应链安全审查 (v4.0)                     构建产物开发（awkn-工程师）
审核工程化/指标追踪 (v4.0)
```

## 核心框架

| 框架 | 用途 |
|------|------|
| 双阶段审查 | 设计审查 + 代码审查 |
| 质量门禁 | pass/pass_with_risks/fail |
| 风险分级 | critical/high/medium/low |
| 安全扫描 | 凭证/命令/依赖三件套 |
| requesting-code-review | 提交审查前自检：git SHA → 子智能体审阅 → 分级修复 |
| receiving-code-review | 审查反馈响应：理解→验证→评估→实施，禁止表演式赞同 |
| triage-state-machine | 问题分类状态机：分类→优先级→路由 |
| AI代码审查 (v4.0) | prompt注入/幻觉防护/模型安全/AI输出安全/工具调用安全 |
| 供应链安全 (v4.0) | SBOM/依赖来源/容器安全/IaC审查 |
| 审核工程化 (v4.0) | SLA指标/变异测试/性能回归/跨项目模式库/自动报告 |
| Meta-review (v4.1) | 审查审查者的标准：断言覆盖度/断言强度/历史一致性 |

## 审查结论标准

| 结论 | 含义 | 动作 |
|------|------|------|
| **PASS** | 全部门禁通过 | 进入 CI/CD (awkn-cicd) |
| **PASS_WITH_RISKS** | 有残余风险但可放行 | 记录风险后进入 CI/CD |
| **FAIL** | 阻塞项存在 | 返回 Build 修复 |

## 完成前验证门控

> 来源：superpowers/verification-before-completion

**铁律**：无新鲜验证证据，不得声称完成

### 门控函数
1. IDENTIFY — 什么命令能证明此声明？
2. RUN — 完整运行（新鲜、完整）
3. READ — 完整输出、exit code、失败计数
4. VERIFY — 输出是否确认声明？
5. ONLY THEN — 做出声明

### 红旗
- 使用 "should" "probably" "seems to"
- 在验证前表达满意（"好了！""完美！"）
- 信任子智能体 success report
- 任何暗示成功但未运行验证的措辞

## 审查分类状态机

> 来源：skills-main/triage

问题进入 → 分类（bug/feature/debt/doc/security/ai-safety）→ 优先级（critical/high/medium/low）→ 路由（awkn-工程师/awkn-部署/awkn-安全）

状态流转：NEW → TRIAGED → IN_PROGRESS → RESOLVED → CLOSED
任一阶段可 → BLOCKED（等待外部输入）

## 自进化机制

| 级别 | 触发方式 | 进化内容 |
|------|---------|---------|
| T1 | 错误触发 | 修正审查规则 |
| T2 | 对话触发 | 吸收新方法论 |
| T3 | 项目触发 | 提炼审查模式 |
| T4 | 定期触发 | 全面优化 |
| T5 | 熔断触发 | 紧急修复 |

---

## 子技能模块索引

### 核心模块 (v1.x - v3.x 积累)

| # | 模块 | 文件位置 | 核心内容 |
|---|------|---------|---------|
| 1 | 质量规则体系 | 天阶功法 `quality-rules.md` | 4维度15条质量规则 |
| 2 | 审查三件套 | 天阶功法 `代码/设计/安全审查规则.md` | 代码审查+设计审查+安全审查 |
| 3 | E-A13~E-A17 审核经验 | `skills/review-workflow/` | 部署chmod/三件套一致性/tasks.md验收/UI身份对齐/并行分析 |
| 4 | 凌扬健身审查规则 | 本文件 §凌扬专项 | 空try-catch/硬编码数字/Markdown XSS |
| 5 | 智能体文档审计 | 本文件 §智能体审计 | 5维度20项(D1人格/D2边界/D3知识/D4对话/D5工程) |
| 6 | E24 Schema覆盖率 | 本文件 §E24 | 所有zod schema必须有测试,覆盖率≥90% |
| 7 | E26 文档反向同步 | 本文件 §E26 | spec↔代码一致性检查 |
| 8 | E25/E26/E27 端到端接线审计 | 本文件 §端到端接线 | 模块PASS vs 接线PASS/入口汇聚点审计/三方对齐 |
| 9 | 部署后必做4验 | 本文件 §部署4验 | HTML title/JS哈希/agent-browser实测/Console错误 |
| 10 | 吸收子技能库 | `skills/` 目录 | 125个子技能(安全28/渗透12/Web10/API6/审查5/测试5...) |

### 新增模块 (v4.0.0)

| # | 模块 | 文件位置 | 核心内容 |
|---|------|---------|---------|
| **11** | **AI 代码审查** | **`skills/ai-code-review/`** | **prompt注入检测/幻觉防护/模型安全/AI输出安全/工具调用安全** |
| **12** | **供应链安全** | **`skills/supply-chain-security/`** | **SBOM审查/依赖来源验证/容器安全/IaC审查** |
| **13** | **审核工程化** | **`skills/review-engineering/`** | **SLA指标/变异测试/性能回归/跨项目模式库/自动报告** |
| **14** | **Meta-review** | **`references/meta-review-protocol.md`** | **审查审查者的标准：断言覆盖度/断言强度/历史一致性/Weak PASS检测** |

---

## 模块 11: AI 代码审查 (v4.0.0 新增)

> 详见 `skills/ai-code-review/SKILL.sub.md`

### 触发条件

用户说「AI审查」「prompt安全」「模型安全」「LLM审查」或审核涉及 AI/LLM 代码时。

### 5 个审查维度

| 维度 | 核心检查 | 严重度 |
|------|---------|--------|
| **Prompt 注入检测** | 用户输入是否直接拼入 system prompt / 是否做消毒 / 角色分离 | Critical |
| **幻觉防护审查** | LLM 输出是否有 grounding 验证 / 是否要求引用 / 置信度评分 | High |
| **模型安全** | 是否有 rate limiting / output truncation / token budget / jailbreak 防护 | High |
| **AI 输出安全** | 输出是否经过毒性过滤/PII脱敏/结构化验证/内容审核 | High |
| **工具调用安全** | 工具参数是否消毒/权限检查/速率限制/审计日志 | Critical |

### 速查清单 (10 条必检)

1. 用户输入拼入 prompt 前是否有 sanitize 函数？
2. system prompt 是否包含用户可控的变量？
3. LLM 输出是否经过 JSON schema 验证？
4. 高风险输出(金融/医疗/法律)是否有人工确认？
5. 工具调用参数是否做了参数类型和范围验证？
6. 工具调用是否有权限检查(who can call what)？
7. 是否有 max_tokens 限制防止输出爆炸？
8. 是否有 rate limiting 防止 API 滥用？
9. LLM 输出是否记录到审计日志？
10. 是否有 fallback 机制(模型不可用时降级)？

---

## 模块 12: 供应链安全 (v4.0.0 新增)

> 详见 `skills/supply-chain-security/SKILL.sub.md`

### 触发条件

用户说「供应链安全」「SBOM」「容器安全」「IaC审查」或审核涉及依赖/容器/基础设施时。

### 4 个审查维度

| 维度 | 核心检查 | 工具 |
|------|---------|------|
| **SBOM 审查** | 依赖清单完整性 + 许可证合规 + 已知漏洞 | CycloneDX / SPDX |
| **依赖来源验证** | 包注册表验证 + typosquatting检测 + 版本锁定 | npm/pip 审计 |
| **容器安全** | 基础镜像漏洞 + 多阶段构建审计 + 非root + 镜像签名 | Trivy / Grype |
| **IaC 审查** | Terraform/K8s安全规则 + 密钥管理 + 漂移检测 | Checkov / tfsec |

### 速查清单 (10 条必检)

1. 是否有 SBOM 文件(CycloneDX/SPDX 格式)？
2. 依赖版本是否锁定(lock file)？
3. 是否有 GPL 等传染性许可证与商业代码混用？
4. 容器基础镜像是否扫描过漏洞(Trivy)？
5. Dockerfile 是否使用多阶段构建(无密钥残留)？
6. 容器是否以非 root 用户运行？
7. Terraform/K8s 是否经过安全规则扫描(Checkov)？
8. 密钥是否通过 Secret Manager 管理(非环境变量)？
9. IaC 是否与实际基础设施一致(漂移检测)？
10. 依赖是否有 typosquatting 风险(名称与官方包相似)？

---

## 模块 13: 审核工程化 (v4.0.0 新增)

> 详见 `skills/review-engineering/SKILL.sub.md`

### 触发条件

用户说「审核指标」「审核SLA」「变异测试」「性能回归」「审核报告」或需要提升审核流程质量时。

### 5 个工程化维度

| 维度 | 核心内容 | 指标 |
|------|---------|------|
| **SLA 与指标** | 审核响应时间/质量/效率 | P0≤2h, P1≤8h, P2≤24h, 缺陷逃逸率<5% |
| **变异测试** | 变异分数门槛/工具集成 | 关键模块≥70%, 普通模块≥50% |
| **性能回归** | 基准对比/自动检测/统计显著性 | ±5%阈值, p<0.05 |
| **跨项目模式库** | 常见反模式/修复模式/分类 | 15+模式,持续积累 |
| **自动报告生成** | 结构化报告/模板/归档 | JSON+Markdown双格式 |

### 审核 SLA 表

| 优先级 | 响应时间 | 完成时间 | 升级条件 |
|--------|---------|---------|---------|
| P0 (阻塞) | 30 min | 2 h | 超时 → 拉架构师 |
| P1 (严重) | 2 h | 8 h | 超时 → 升级 P0 |
| P2 (一般) | 4 h | 24 h | 超时 → 升级 P1 |
| P3 (轻微) | 8 h | 72 h | 超时 → 提醒 |

---

## 模块 14: Meta-review (v4.1.0 新增)

> 详见 `references/meta-review-protocol.md`
> 核心命题：谁审查审查者？Weak PASS 比 FAIL 更危险 — 它制造虚假信心。

### Meta-review 自动触发

- 审核通过率 > 90% 但产出明显有问题 → 标准太松
- 审核通过率 < 30% 但产出合理 → 标准太紧
- 标准与上次同类审核差异 > 30% → 漂移警告

详见 `references/meta-review-protocol.md`

---

## 质量保障体系

> 来源：awkn-程序员天阶功法 v2.9.0 瘦身下沉

4 维度 15 条质量规则，详细定义见天阶功法 `quality-rules.md`。

审查三件套：

| 审查维度 | 规则文件 |
|---------|---------|
| 代码审查 | `02_技术与交付主链/02_11_代码审查规则.md` |
| 设计审查 | `02_技术与交付主链/02_12_设计审查规则.md` |
| 安全审查 | `02_技术与交付主链/02_13_安全审查规则.md` |

## 质量标准 6 条

| # | 标准 | 含义 | 验证方式 |
|---|------|------|---------|
| 1 | 定义精确 | 不使用模糊表述 | 检查"大概""可能"等模糊词 |
| 2 | 代码完备 | 关键结论有可运行代码 | 代码可直接执行无报错 |
| 3 | 推导可验证 | 每步推导可独立验证 | 逐步检查逻辑链无跳跃 |
| 4 | 误区有据 | 误区基于真实痛点 | 可在社区/论坛找到案例 |
| 5 | 量级具体 | 给出具体数值 | 有具体数字而非"很快" |
| 6 | 边界明确 | 说明适用范围和失效条件 | 有"不适用于"说明 |

---

## 吸收子技能库（antigravity-awesome-skills）

> 吸收日期：2026-05-19 | 来源：antigravity-awesome-skills | v2.5.0 精简至 125 个

| 分类 | 数量 |
|------|------|
| 安全审计与扫描 | 28 |
| 渗透测试 | 12 |
| Web安全 | 10 |
| API安全 | 6 |
| 代码审查与审计 | 5 |
| TDD与测试工程 | 5 |
| 威胁建模 | 4 |
| 合规与风险 | 8 |
| 事件响应 | 1 |
| 认证与密钥管理 | 6 |
| 基础设施安全 | 5 |
| 移动安全 | 1 |
| 其他安全 | 8 |
| 平台专项 | 10 |
| UI/UX审查 | 2 |
| DevOps/CI/CD | 4 |
| 数据与数据库 | 5 |
| 法律与合规 | 3 |
| AI/ML安全 | 2 |
| **合计** | **125** |

> 子技能索引：`skills/README.md`

---

## 融合入口

### 来自 webapp-testing（共享入口）
- **触发词**：Web测试, webapp-testing, Playwright
- **融合方式**：split_by_owner（另一入口在 awkn-工程师）

### 来自 vulnerability-scanner（第二批融合）
- **触发词**：漏洞扫描, OWASP 2025, 供应链安全, 攻击面映射
- **融合方式**：merge_variants（4 变体合并）

### 来自 security-scanning-security-sast（第二批融合）
- **触发词**：SAST, 静态安全测试, Semgrep, Bandit, CodeQL
- **融合方式**：merge_variants（4 变体合并）

### 来自 openclaw-security（引用入口）
- **触发词**：安全防护, 群聊安全, 社工攻击
- **融合方式**：reference_entry

---

## 凌扬健身专项审查规则 (v3.0.2)

### 空 try-catch 检查
- 禁止空 try-catch（至少 `logger.error`）
- 禁止 catch 块内只有 `console.log`（必须用项目 logger）
- **教训**：凌扬健身 11 处空 catch，错误被静默吞掉

### 硬编码数字检查
- 超时/延迟/阈值必须提取为命名常量
- 常量放在 config/ 目录或文件顶部
- **教训**：凌扬健身 4 处硬编码数字(打字速度24ms/最大打字时长3000ms)

### Markdown XSS 检查
- AI 回复渲染必须经过 DOMPurify 消毒
- 禁止直接 `v-html="aiResponse"` 不经消毒
- 白名单必须排除 `<script>` `<iframe>` `<object>` `<embed>` `<form>`
- **教训**：凌扬健身 AI 回复 Markdown 渲染未消毒

---

## E24 Schema 测试覆盖率门槛

- 新增 Zod/Yup/Joi schema 必须配套测试
- 覆盖率 = 已测场景/总场景 ≥ 90%
- 必测：边界值 + 拒绝场景 + 接受场景
- **教训**：awkn-agent 7 个新 schema 无测试

---

## E25/E26/E27 端到端接线审计

### E25: 模块自包含 PASS vs 端到端接线 PASS
- 两类检查必须分别跑：模块独立测试 + 入口调用链验证
- **反例**：mailbox.ts 6 函数全通过但 chat handler 未调用

### E26: 入口汇聚点独立审计
- 入口文件有专属"接入 phase 矩阵表"
- 入口文件修改必有集成测试
- 入口文件代码量 < 2000 行

### E27: 函数-路由-工具 三方对齐
- service 函数 ↔ API 路由 ↔ AI tool 三方对齐表
- 缺失对齐表 → 判定 FAIL

---

## E28｜零测试交付门禁（v4.0.1 新增，2026-06-12）

### E28.1 触发条件
- 新建模块 / service / 核心逻辑
- 代码行数 > 100 行但无对应 .spec.ts
- 准备标记"功能完成"时

### E28.2 核心规则

**零测试 = 未交付。** 任何新增模块必须至少 1 条测试，否则判定 FAIL。

验收标准：
- 每个 service 至少 1 条核心逻辑测试
- 覆盖率不要求高，但必须 > 0
- 测试必须可独立运行（`npm test` 或 `npx vitest`）

### E28.3 反例
kline-tide.service.ts 629 行，0 个 .spec.ts 文件。无法验证数据解析逻辑、OHLCV 计算、fallback 生成是否正确。

### E28.4 防复发
- 开发流程中"写测试"必须在"标记完成"之前
- 质量门禁增加"测试文件存在性检查"（glob 对应模块目录下是否存在 .spec.ts）

### 教训来源
2026-06-12 K线/潮汐批量交付深度复盘：2,326 行核心代码，零测试

---

## E29｜本地等价 vs 远端 CI 双证据门禁（v4.1.1 新增，2026-07-23）

> **核心断言**：本地等价验证（CI 同步骤本地复跑）和远端 CI 实际运行结果是两套独立证据，不能互替
> 来源：annie-codex-H5 上线闭环深度复盘（Run 30022317805）

### E29.1 触发条件
- push 后需要验证 CI 是否全绿
- 本地用 CI 完全相同的命令（同 env、同 jest 路径、同 testPathIgnorePatterns）跑了一遍全绿
- 企图用本地结果直接判定"CI 已验证通过"

### E29.2 核心规则

**本地等价绿 ≠ 远端 CI 绿。** 两者是独立验收点，必须分别取证：

| 证据类型 | 证明什么 | 不证明什么 |
|---------|---------|----------|
| 本地等价验证 | 代码本身语法/加载/单测没问题 | 远端 CI 实际跑通 |
| 远端 CI 实际结果 | 真实环境跑通了完整流水线 | （不需要补充） |

**典型差异来源**：
- 远端 CI 环境与本地不同（Node 版本矩阵、Ubuntu vs Windows、依赖锁版本）
- 远端 CI 跑的步骤更多（h5-build、security-audit、deploy 条件判断）
- 远端 CI 可能因 secrets/环境变量缺失而失败（本地 mock 了）
- 远端 CI 有 matrix 并行（Node 20 + Node 22），本地通常只跑一个版本

### E29.3 反例
annie 上线闭环验证时，本地跑 `npx jest tests/unit/` 全绿（48 套件/330 测试），差点据此判定"CI 验证通过"。实际上：
- 本地没跑 h5-build（Vite 构建可能因依赖缺失失败）
- 本地没跑 security-audit（npm audit 可能报 critical）
- 本地没验证 [skip-deploy] 标记是否真的让 deploy job 跳过
- 本地 Node 版本可能不是 matrix 中的 20/22

最终通过 git credential + Bearer API 确认远端 Run 30022317805 的 4 个 job 实际状态，才完成独立验收。

### E29.4 教训（按原则 18 3 写）
- **写 1 教训**：验收清单里"CI 验证"必须拆成两个独立验收点——"本地等价绿"和"远端 CI 绿"，禁止合并表述
- **写 2 反例**：本地 jest 全绿 → 判定"CI 验证通过" → 漏掉 h5-build/security-audit/deploy 状态 → 验收假绿
- **写 3 触发词**：CI 验证 / 本地等价 / 远端 CI / push 后验证 / workflow run / 验收点拆分 / 双证据

### E29.5 防复发
- 验收清单模板：`[ ] 本地等价验证（语法+加载+单测）` + `[ ] 远端 CI 实际运行结果（gh/API 取证）`
- 远端 CI 取证方式见 awkn-工程师 E43（gh CLI → git credential fill + Bearer API → 本地等价降级路径）
- 禁止用"本地跑通了"作为远端 CI 通过的唯一证据

### 教训来源
2026-07-23 annie-codex-H5 上线闭环深度复盘：本地 jest 全绿差点被当成 CI 全绿

---

## E-A13~E-A17 审核经验 (v3.0.0)

| # | 经验 | 核心规则 |
|---|------|---------|
| E-A13 | scp 上传后 chmod | 部署后有 `chmod -R a+rX` + curl 验证无 403 |
| E-A14 | Vite base 三件套 | vite.config base + Router basename + Nginx location 一致 |
| E-A15 | tasks.md checkbox | `[x]` 不代表已验证，必须有独立验证证据 |
| E-A16 | UI 身份对齐 | 产品名→视觉隐喻映射表，至少3处可感知 |
| E-A17 | 多项目并行分析 | 2+独立项目用子 agent 并行，时间节省50% |

---

## 部署后必做 4 验 (v2.9.0)

| 顺序 | 验证项 | 工具 | 通过标准 |
|------|-------|------|---------|
| 1 | HTML title 身份校验 | curl | 标题与项目预期一致 |
| 2 | JS 哈希一致性 | curl + 本地 dist | 主 bundle 哈希匹配 |
| 3 | agent-browser 流程实测 | agent-browser | 关键 DOM/文本/组件真实渲染 |
| 4 | Console 错误扫描 | agent-browser eval | 无 ReferenceError / TypeError |

> **教训**：取名页 3 轮部署全因"静态4验通过但实际渲染失败"

---

## 智能体文档审计框架 (v2.0)

> 参照 Annie 林嘉怡角色设计四文档结构

### 5 维度 20 项

| 维度 | 权重 | 必过项 |
|------|:---:|--------|
| D1 人格完整性 | 25% | 人格文件+根法则+核心矛盾+说话风格≥3+边界≥3 |
| D2 信息边界 | 20% | 边界宣言+能断言+不能断言 |
| D3 知识库 | 20% | 核心DB≥3+信息来源标注≥60%+失效日期 |
| D4 对话能力 | 20% | 样例≥10+路由设计+情绪感知+输出后处理+格式控制区分 |
| D5 工程架构 | 15% | Token预算+记忆持久化+错误降级+冒烟检查+回滚+prompt≤15000+enforceFormat |

**通过标准**：D1≥3/5, D2≥2/3, 其他≥60%, 总分≥70%

---

## 文件保护等级

| 等级 | 含义 | 适用文件 |
|------|------|---------|
| 🔴 绝对保护 | 版本升级时才修改 | SKILL.md 核心定义 |
| 🟠 结构锁定 | 仅明确需求时修改结构 | docs/、核心子技能 |
| 🟡 追加增长 | 可追加新条目，不改已有 | skills/ 新子技能 |
| 🟢 自由生长 | 自由创建修改 | scripts/、templates/ |

## 版本历史

| 版本 | 日期 | 修改内容 |
|------|------|---------|
| v4.1.0 | 2026-06-12 | 新增模块14 Meta-review：审查审查者的标准（断言覆盖度/断言强度/历史一致性/Weak PASS检测），来源：Meta_Kim ten-step-governance.md Phase 5 |
| v4.1.1 | 2026-07-23 | 新增 E29 本地等价 vs 远端 CI 双证据门禁（来源：annie-codex-H5 上线闭环深度复盘） |
| v4.0.1 | 2026-06-12 | 新增 E28 零测试交付门禁（来源：K线/潮汐批量交付深度复盘） |
| v4.0.0 | 2026-06-11 | **工程级升级**: 新增模块11(AI代码审查:prompt注入/幻觉/模型安全/输出安全/工具调用安全) + 模块12(供应链安全:SBOM/依赖来源/容器/IaC) + 模块13(审核工程化:SLA/变异测试/性能回归/模式库/自动报告) + SKILL.md 重构为路由层 |
| v3.0.2 | 2026-06-08 | +3 审查规则：空try-catch、硬编码数字、Markdown XSS |
| v3.0.0 | 2026-06-07 | 新增 E-A13~E-A17 审核经验 |
| v2.9.0 | 2026-06-05 | 新增 G5-G7 审查规则 + 部署后必做4验 |
| v2.8.0 | 2026-06-01 | 新增 E24 Schema覆盖率 + E26文档反向同步 + E25/E26/E27端到端接线 |
| v2.7.0 | 2026-05-26 | 吸收 superpowers + triage |
| v2.0.0 | 2026-05-04 | 架构升级 |
| v1.0.0 | — | 初始版本 |
