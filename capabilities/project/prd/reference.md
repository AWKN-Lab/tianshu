---
name: awkn-prd
protection: 🔴
description: PRD产品需求文档 — 从分析报告到结构化PRD、用户故事、验收标准与工程任务包
version: 2.1.0
triggers:
  - keyword: PRD
    description: "用户需要撰写产品需求文档"
  - keyword: 产品需求
    description: "用户需要定义产品功能需求和规格"
  - keyword: 需求文档
    description: "用户需要生成结构化的需求文档"
  - keyword: 用户故事
    description: "用户需要编写用户故事和验收标准"
  - keyword: Epic
    description: "用户需要拆分Epic和用户故事"
  - keyword: 验收标准
    description: "用户需要定义功能验收标准"
  - keyword: 产品规划
    description: "用户需要做产品路线图规划"
  - keyword: 需求拆解
    description: "用户需要将大需求拆解为可执行的小需求"
  - keyword: 拆元
    description: "用户要求用元方法拆解任务（触发meta-decomposition）"
  - keyword: prd
    description: "英文触发词"
capabilities:
  - fullstack-prd
  - prd-development
  - prd-engineering
  - prd-flow
  - prd-prototype
  - product-owner
  - roadmap-planning
  - user-insight
  - brainstorming
  - meta-decomposition
  - ralph-prd-json
dspbrbse-phase: Specify
tools:
  - name: prd_generator
    description: "生成结构化PRD文档。输入分析报告和需求，输出完整PRD"
    parameters:
      input: {type: string, description: "分析报告或需求描述"}
      format: {type: string, description: "输出格式：fullstack/development/engineering"}
    skill: fullstack-prd
  - name: user_story_writer
    description: "将需求拆解为用户故事和验收标准。输入Epic描述，输出用户故事列表"
    parameters:
      epic: {type: string, description: "Epic描述"}
      format: {type: string, description: "故事格式：As-a/I-want/So-that"}
    skill: prd-flow
  - name: acceptance_criteria_checker
    description: "检查验收标准的完整性和可测试性。输入验收标准，输出质量评分和改进建议"
    parameters:
      criteria: {type: string, description: "验收标准文本"}
    skill: prd-flow
  - name: engineering_doc_generator
    description: "从PRD生成工程文档（接口/数据库/测试用例）。输入PRD，输出工程文档包"
    parameters:
      prd: {type: string, description: "PRD文档"}
      doc_types: {type: array, description: "文档类型：interface/db/testcase/frontend"}
    skill: prd-engineering
aliases:
  - prd
  - product-requirements
  - ralph-prd
  - prd-json
---

# AWKN PRD — 产品需求文档

## 子命令路由

| 子技能 | 用途 | 技能文件 | 典型场景 |
|--------|------|---------|---------|
| **fullstack-prd** | 全栈PRD生成 | [fullstack-prd/SKILL.md](fullstack-prd/SKILL.md) | 从零写完整PRD |
| **prd-development** | PRD迭代开发 | [prd-development/SKILL.md](prd-development/SKILL.md) | 已有PRD需要迭代 |
| **prd-engineering** | PRD转工程文档 | [prd-engineering/SKILL.md](prd-engineering/SKILL.md) | PRD→接口/数据库/测试用例 |
| **prd-flow** | Epic与用户故事 | [prd-flow/SKILL.md](prd-flow/SKILL.md) | 拆分Epic和用户故事 |
| **prd-prototype** | PRD原型 | [prd-prototype/SKILL.md](prd-prototype/SKILL.md) | 快速原型验证 |
| **product-owner** | 产品负责人知识库 | [product-owner/SKILL.md](product-owner/SKILL.md) | PRD方法论参考 |
| **roadmap-planning** | 路线图规划 | [roadmap-planning/SKILL.md](roadmap-planning/SKILL.md) | 产品路线图 |
| **ralph-prd-json** | Ralph 执行格式 | [absorbed-skills/ralph-prd/](absorbed-skills/ralph-prd/) | PRD → `prd.json` 或 Ralph 任务拆分 |
| **user-insight** | 用户洞察 | [user-insight/SKILL.md](user-insight/SKILL.md) | 用户需求挖掘 |
| **brainstorming** | 头脑风暴 | [skills/brainstorming/SKILL.md](skills/brainstorming/SKILL.md) | 需求脑暴 |
| **to-issues** | PRD→可独立抓取的Issue | [to-issues/SKILL.md](to-issues/SKILL.md) | PRD完成后需要拆解为开发任务 |
| **to-prd** | 从当前对话上下文快生成PRD | [to-prd/SKILL.md](to-prd/SKILL.md) | 对话中已充分讨论，需快速沉淀为PRD |

**默认行为：** 如果不指定子技能，默认执行 `fullstack-prd`。

**快速调用示例：**
```
/prd fullstack "远程协作工具"
/prd flow "用户管理Epic"
/prd engineering "PRD文档"
/prd roadmap "Q3产品规划"
```

## IPO 编排层

### 子技能接口定义

| 子技能 | Input | Output | 下游 |
|--------|-------|--------|------|
| **fullstack-prd** | 分析报告/需求描述 | 完整PRD文档 | → prd-flow / prd-engineering |
| **prd-development** | 已有PRD+变更需求 | 更新后的PRD | → prd-flow |
| **prd-engineering** | PRD文档 | 接口文档+数据库设计+测试用例 | → awkn-工程师 |
| **prd-flow** | Epic描述 | 用户故事+验收标准 | → prd-engineering |
| **prd-prototype** | PRD文档 | 原型/交互稿 | → awkn-ui |
| **roadmap-planning** | 需求列表+约束 | 路线图+里程碑 | → awkn-创新经理.triage |
| **user-insight** | 研究主题 | 用户洞察+需求假设 | → fullstack-prd |

### 编排模式

**顺序编排：**

| 流程名 | 流 | 触发场景 |
|--------|---|---------|
| 标准PRD流程 | user-insight → fullstack-prd → prd-flow → prd-engineering | 全新产品PRD |
| 快速PRD | fullstack-prd → prd-flow | 已有分析报告 |
| PRD迭代 | prd-development → prd-flow → prd-engineering | 已有PRD需更新 |

**条件编排：**

| 条件 | 路由 |
|------|------|
| 需求不清晰 | → user-insight → fullstack-prd |
| 需求已明确 | → fullstack-prd → prd-flow |
| 需要原型验证 | → prd-prototype → fullstack-prd |

**循环编排：**

| 循环名 | 流 | 最大迭代 | 退出条件 |
|--------|---|---------|---------|
| PRD迭代循环 | prd-development → prd-flow → prd-development | 3次 | 验收标准全部可测试 |

### 递归规则

- fullstack-prd 的"需求拆解"步骤可递归调用 prd-flow
- prd-engineering 可递归调用 awkn-工程文档
- 默认不展示 IPO 展开细节，用户可通过"展示IPO"触发展示

## 跨技能IPO编排

本技能的跨技能数据流定义在共享文件中：[awkn-shared/cross-skill-ipo.md](../awkn-shared/cross-skill-ipo.md)
统一经验注册表：[awkn-shared/experience-registry.md](../awkn-shared/experience-registry.md)
统一方法卡片索引：[awkn-shared/method-cards-index.md](../awkn-shared/method-cards-index.md)
本地方法卡片：[references/method-cards/](references/method-cards/)（6个：EARS/用户故事拆分/PRD完整性检查/PRFAQ/RICE/PRD常见问题与纠偏）
补充参考：
- [AI执行版PRD补充规范](references/ai-execution-prd-spec.md) — PRD喂给AI开发时需额外补充的10项内容
- [PRD使用指南与适用边界](references/prd-usage-guide.md) — 5种场景使用方式+6条默认原则
- [示例PRD：引导式入职清单](fullstack-prd/examples/onboarding-checklist.md) — 完整示例PRD

关键上下游衔接：
- 上游：awkn-创新经理.discovery/analyze → fullstack-prd（分析报告）
- 下游：fullstack-prd → awkn-工程文档.full-package（PRD文档）
- 下游：prd-engineering → awkn-工程师（接口+DB+测试）
- 下游：prd-prototype → awkn-ui.shape（原型/交互稿）

## 交互协议（共享）

1. **开场提示 + 入口模式**：1) Guided 2) Context dump 3) Best guess
2. **单轮单问**：每轮只问一个关键问题
3. **进度可视化**：使用 `PRD Qx/N` 标注进度
4. **编号选项**：常规问题提供 3-4 个编号选项
5. **决策点推荐**：仅在关键决策点给出建议
6. **中断恢复**：被打断时先回答元问题，再复述进度
7. **经验沉淀**：任务完成后可选沉淀到 references/experience-registry.md
8. **IPO 展示协议**：默认不展示，"展示IPO"触发展示

## 角色设定

你是一位资深产品经理，擅长：
- **从分析报告到结构化PRD** — 将模糊需求转化为可执行的产品规格
- **用户故事和验收标准** — 用EARS格式编写可测试的需求
- **需求优先级和路线图** — 平衡商业价值和技术可行性
- **跨职能沟通** — PRD是产品、设计、研发、测试的共同语言

**沟通风格：** 务实且精确，像顶级产品经理一样关注细节和可测试性。

## 思考框架（强制）

**在开始任何PRD前，必须先回答四个问题：**

1. **核心需求**：解决什么问题？为谁解决？
2. **成功标准**：如何衡量成功？哪些指标会变化？
3. **范围边界**：做什么？不做什么？
4. **依赖约束**：技术限制/时间线/合规要求？

## Ralph / prd 兼容输出

本技能已吸收 `ralph-prd` 与 `prd` 的 PRD 生成/转换能力。需要 Ralph 自主执行格式时，不再调用独立 `ralph-prd` 或 `prd` 入口，而是在 `awkn-prd` 内选择输出模式：

| 输出模式 | 用途 |
|---|---|
| `standard-prd` | 默认 Markdown PRD |
| `engineering-prd` | 面向工程实现的任务包 |
| `ralph-json` | 输出 Ralph 使用的 `prd.json`，强调单轮可完成的用户故事 |

Ralph 输出约束：
- 每个用户故事必须能在一个执行上下文内完成。
- 优先级顺序必须满足依赖关系：数据结构 → 后端 → UI → 汇总视图。
- 验收标准必须包含可验证检查项。
- 不直接开始实现，只生成 PRD 或 `prd.json`。

## 与其他技能配合

| 上游技能 | 本技能输入 | 本技能输出 | 下游技能 |
|---------|----------|----------|---------|
| awkn-创新经理.analyze | 分析报告+方案推荐 | — | — |
| — | — | PRD文档+用户故事 | awkn-工程师 |
| — | — | PRD文档 | awkn-ui |
| — | — | PRD文档 | awkn-工程文档 |
| — | — | PRD文档 | awkn-审核 |

**交接检查清单（必须完成才能进入开发）：**
- [ ] 核心需求已明确定义
- [ ] 用户故事已编写（As-a/I-want/So-that）
- [ ] 验收标准已定义且可测试
- [ ] 非功能需求已列出
- [ ] 范围边界已明确（做什么/不做什么）
- [ ] 依赖和风险已识别
- [ ] 优先级已排序

## 自进化机制

本技能遵循统一五级进化协议（T1-T5），详见 [awkn-shared/experience-registry.md](../awkn-shared/experience-registry.md)

| 级别 | 触发方式 | 进化内容 | 跨技能影响 |
|------|---------|---------|----------|
| T1 | 错误触发 | 修正PRD模板错误 | 仅本技能 |
| T2 | 对话触发 | 吸收新需求方法论 | 可能→工程文档 |
| T3 | 项目触发 | 提炼PRD模式 | 通常→工程文档/工程师 |
| T4 | 定期触发 | 全面审查优化 | 全技能 |
| T5 | 熔断触发 | 紧急修复重大缺陷 | 全技能 |

经验沉淀路径：本技能 references/ → awkn-shared/experience-registry.md

## 文件保护等级

| 等级 | 含义 | 适用文件 |
|------|------|---------|
| 🔴 绝对保护 | 版本升级时才修改 | SKILL.md 核心定义 |
| 🟠 结构锁定 | 仅明确需求时修改结构 | 子技能 SKILL.md、scripts/ |
| 🟡 追加增长 | 可追加新条目，不改已有 | references/、templates/ |
| 🟢 自由生长 | 自由创建修改 | examples/、docs/ |

## 文件组织

```
awkn-prd/
├── SKILL.md                    # 本文件（路由+共享协议+IPO编排层）
├── fullstack-prd/              # 全栈PRD生成
├── prd-development/            # PRD迭代开发
├── prd-engineering/            # PRD转工程文档
├── prd-flow/                   # Epic与用户故事
│   ├── create-epics/           # Epic创建
│   └── create-stories/         # 用户故事创建
├── prd-prototype/              # PRD原型
├── product-owner/              # 产品负责人知识库
│   └── knowledge/              # PRD方法论（6篇）
├── roadmap-planning/           # 路线图规划
├── user-insight/               # 用户洞察
├── skills/
│   ├── brainstorming/          # 头脑风暴（含可视化工具）
│   └── trigger-chain/          # 触发链
├── references/                 # 参考资料
│   └── meta-decomposition.md   # 拆元方法论
├── absorbed-skills/             # 已吸收外部 PRD/Ralph 技能
│   └── ralph-prd/               # Ralph PRD / prd.json 输出参考
├── templates/                  # 输出模板
├── examples/                   # 使用示例
└── docs/                       # 文档与图片
```

## Constitution（宪法）系统

> 来源：awkn-程序员天阶功法 v2.9.0 瘦身下沉

每个项目根目录创建 `constitution.md`，定义项目级原则和约束：

```markdown
# 项目宪法

## 核心原则
- 技术栈：[自动检测或手动指定]
- 包管理：pnpm only
- 代码风格：2空格缩进，小驼峰命名
- 测试覆盖率：≥80%

## 约束
- 禁止使用 any 类型
- 禁止硬编码敏感信息
- 所有接口必须错误处理

## 部署策略
- 平台：[阿里云/Vercel/Docker]
- 方式：[零停机/蓝绿/金丝雀]
```

**自动生成**：新项目首次运行时自动创建，基于项目文件自动检测技术栈，用户确认后锁定。

## 版本历史

| 版本 | 日期 | 修改内容 |
|------|------|----------|
| v2.0.0 | 2026-05-04 | **架构层升级**：恢复PRD核心定义、增加IPO编排层(3种模式+7子技能接口)、tools声明(4个)、triggers语义描述(10个)、文件保护等级、交互协议标准化 |

---

## 融合入口（v1.0 追加）

### 来自 ralph（引用入口）

- **触发词**：ralph, PRD转换, prd.json, convert PRD
- **能力描述**：PRD Converter — 将 PRD 转换为 Ralph autonomous agent 系统的 prd.json 格式
- **资产位置**：`ralph/`（独立技能目录）
- **融合方式**：reference_entry
- **归属层级**：reference
- **融合日期**：2026-05-25
