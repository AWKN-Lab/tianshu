# 技能注册表（Skill Registry）

> 天火调度 AWKN 技能包的唯一权威索引。
> 触发条件命中时，优先读取对应技能包 SKILL.md，按其流程执行。

## 技能路由表

| 触发条件（关键词） | 不适用于 | 技能包 | 路径 | 入口锚点 | 产出物 |
|------------------|---------|--------|------|---------|--------|
| 改已有项目/改代码/修复bug/加功能/重构/执行检查 | 纯查询已有代码逻辑/只读不写 | awkn-执行检查 | `.claude/skills/awkn-执行检查` | SKILL.md#五步流程 | 改动计划 + 验证报告 |
| @程序员/@天阶/工程大脑/继续项目/项目开发流程 | 只需要单一阶段具体执行时，应路由到对应阶段技能 | awkn-程序员天阶功法 | `.claude/skills/awkn-程序员天阶功法` | SKILL.md#瘦身原则只做调度不做执行 | 阶段判断 + 技能路由 + Handoff |
| 写代码/实现/技术方案/排错/测试 | 纯解释概念/只回答技术问题不写代码 | awkn-工程师 | `.claude/skills/awkn-工程师` | SKILL.md#8阶段执行脊 | 代码 + diff + 测试证据 |
| 工程文档/接口文档/数据库设计/测试用例 | 纯口头描述/不要求产出文档文件 | awkn-工程文档 | `.claude/skills/awkn-工程文档` | SKILL.md#核心流程 | 文档包 |
| 审核/代码审查/review/QA/安全审查 | 自我评价/非代码类审查 | awkn-审核 | `.claude/skills/awkn-审核` | SKILL.md#审查结论标准 | 审查报告 |
| CI/CD/流水线/自动测试/自动发布/pipeline/持续集成/持续部署 | 只做本地一次性验证/不需要流水线结果单 | awkn-cicd | `.claude/skills/awkn-cicd` | SKILL.md#核心 Pipeline | Pipeline 结果单 + 质量门禁结论 |
| 部署/上线/灰度/回滚/Ship/生产发布 | 本地开发环境操作/不涉及生产 | awkn-部署 | `.claude/skills/awkn-部署` | SKILL.md#子技能路由 | 部署结果 + 健康报告 |
| 复盘/经验沉淀/总结/能力进化 | 单次简单反馈/不需要结构化复盘 | AWKN 复盘总结 | `.claude/skills/AWKN 复盘总结` | SKILL.md#模块A/B/C | 复盘结论 + 写回决策 |
| Constitution/宪法/项目原则 | 纯代码实现不涉及项目规范 | awkn-prd | `.claude/skills/awkn-prd` | SKILL.md#Constitution宪法系统 | 项目宪法 constitution.md |
| Delta Specs/增量变更/变更管理 | 纯文档生成不涉及变更流程 | awkn-工程文档 | `.claude/skills/awkn-工程文档` | SKILL.md#Delta Specs增量变更 | 变更提案 + 设计 + 任务 |
| 质量保障/质量规则/4维度15条/质量标准6条 | 非代码质量审查 | awkn-审核 | `.claude/skills/awkn-审核` | SKILL.md#质量保障体系 | 质量规则 + 审查三件套 |
| 原子讲解/概念讲解/4层结构 | 纯代码编写不涉及概念讲解 | awkn-工程师 | `.claude/skills/awkn-工程师` | SKILL.md#原子讲解4层结构 | 4层讲解输出 |
| 子技能库/技能索引/214技能 | 纯技能开发不涉及索引 | awkn-技能治理 | `.claude/skills/awkn-技能治理` | SKILL.md#吸收子技能库 | 技能索引 + 分类统计 |

## Loop Engineering 技能映射 (v6.3 新增)

> 来源：`loop-engineering/skill-registry-loop.md`
> 12 个核心 Loop 技能的天火路由映射。命中触发条件时按 Loop 角色加载。

| 技能名 | Loop 角色 | 触发条件 | L 层级 | 产出物 |
|--------|----------|---------|--------|--------|
| awkn-意图理解 | L1 前置 | 意图不清/模糊词/歧义 | L1 | intentPacket |
| awkn-调研员 | L1 前置 | 调研/查一下/研究/搜索 | L1 | 调研报告 + 交叉验证结论 |
| awkn-执行检查 | L1 验证 | Execute 后强制接入 | L1 | 验证报告（fresh evidence） |
| awkn-工程师 | L1/L2 执行 | 写代码/实现/排错/测试 | L1, L2 | 代码 + diff + 测试证据 |
| awkn-spec | L2 前置 | /goal 进入方案冻结 | L2 | spec + 冻结方案 |
| awkn-工程文档 | L2 前置 | /goal 进入方案冻结 | L2 | 交接包 + 文档 |
| awkn-cicd | L2 评估器 | 跑门禁/评估停止条件 | L2 | Pipeline 结果 + 门禁结论 |
| awkn-程序员天阶功法 | L2/L4 调度 | 循环体调度/阶段 Handoff | L2, L4 | 阶段判断 + 技能路由 |
| awkn-审核 | quality gate | 审核门禁/代码审查/review | L1, L2, L4 | 审查报告 |
| awkn-bug修复大法 | L2 专用 | 修 bug/复现问题/BUG 反复 | L2 | 复现证据 + 修复 + 验证 |
| AWKN 复盘总结 | evolve 写回 | 循环结束/经验沉淀/复盘 | L1, L2, L3, L4 | evolutionWritebackPacket |
| awkn-部署 | L4 手动 gate | 上线/灰度/回滚/生产发布 | L4 | 部署结果 + 健康报告 |

调度补充：

- L1 默认链：awkn-意图理解 → awkn-调研员 → ... → awkn-工程师 → **awkn-执行检查(Verify)** → awkn-审核 → awkn-复盘总结
- L2 循环体：awkn-程序员天阶功法(调度) → awkn-工程师(执行) → awkn-审核+awkn-cicd(门禁) → 评估器判定
- L2 bug 专用：失败时改走 awkn-bug修复大法，不重复执行同一失败动作
- L4 手动 gate：awkn-部署 必须用户确认 + safetyGate，无例外

## 调度规则

1. **Classify 阶段**：命中触发条件 → `taskClassificationPacket.route_to_skill = [技能包名]`
2. **Execute 阶段**：检查 `route_to_skill` → 读取对应 SKILL.md → 按技能流程执行
3. **技能包内子流程**：由技能自身定义（如 awkn-工程师的 8 阶段执行脊）
4. **多技能协作**：同一任务可能需要多个技能（如 Build 先执行检查，再工程师实现，再审核审查）
5. **无匹配 fallback**：未命中任何触发词时，使用天火原有自主执行逻辑

## 已有项目修改强制链

命中以下任一条件时，天火必须自动补齐技能链，不要求用户手动点名：

- 用户在已有项目中提出需求、新想法、bug、报错、优化、重构、部署或验证请求。
- 任务可能修改代码、配置、规则、文档、数据库、部署脚本或线上资源。
- 用户说"继续项目""这个项目""帮我改""修复""做一下"等省略技能名的表达。

默认链路：

```
awkn-执行检查
  -> plan任务计划
  -> awkn-工程文档
  -> awkn-程序员天阶功法
  -> awkn-工程师
  -> awkn-审核
  -> awkn-cicd
  -> awkn-部署(仅上线/生产/回滚时)
```

硬门禁：

1. 未完成 awkn-执行检查的 Read/Locate/Plan，不得开始修改已有项目。
2. 工程文档默认需要；仅低风险单文件小改可记录"跳过原因"后跳过。
3. awkn-工程师完成后必须进入 awkn-审核；没有 fresh verification evidence 不得声称完成。
4. Review 未 PASS/PASS_WITH_RISKS，不得进入 CI/CD 或部署。
5. CI/CD 未 PASS/RISK人工确认，不得进入 awkn-部署。

## 软接入说明

天火通过以下方式调用技能：
1. 读取 `archive/SKILL-REGISTRY.md` 获取技能路径
2. 读取技能包根目录的 `SKILL.md` 获取入口锚点
3. 按 SKILL.md 中的流程执行，同时保留天火 safetyGate / verificationGate 拦截权
4. 技能更新后无需同步修改天火，技能自治

若软接入失败（天火无法按 SKILL.md 执行），自动降级为硬编码模式：将核心流程写进 agent.prompt。