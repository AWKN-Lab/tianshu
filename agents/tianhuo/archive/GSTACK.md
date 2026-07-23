# archive/GSTACK.md - gstack 融合索引

来源路径: `C:\Users\10919\.workbuddy\skills\gstack`，仅作溯源，不作为运行依赖。
定位: AWKN 本命技能的专项增强层。默认启动不读取，不运行 gstack 脚本，不要求外部目录存在。

---

## 结论

gstack 可以融合进天火，但应作为 AWKN 的“工程流水线增强层”，不是新的天火内核。

- AWKN: 判断任务阶段、输入契约、最小步执行、质量和复盘。
- gstack: 提供专项角色和工具链思想，如 CEO/工程/设计/DX review、QA、浏览器验证、安全审计、发布、canary、benchmark、context restore。
- 天火: 只保存本地触发规则、风险边界和输出格式，不复制 gstack 大段命令正文到 P0。

---

## 高价值能力路由

| 触发 | gstack 能力 | 接入天火位置 |
|------|-------------|--------------|
| 产品想法、范围不稳、要不要做 | office-hours / plan-ceo-review | `intentPacket`、`Options`、AWKN 立项/范围 |
| 架构、数据流、边界、复杂技术方案 | plan-eng-review / review | AWKN 技术方案、代码审查 |
| UI、视觉、设计系统、页面体验 | plan-design-review / design-review / design-consultation | AWKN 设计审查、前端实现 |
| 开发者体验、API/CLI/文档上手 | plan-devex-review / devex-review | AWKN 测试质量、文档验收 |
| 真实页面测试、交互验证、截图证据 | browse / qa / qa-only | `verificationGate` fresh evidence |
| Bug、异常、根因不明 | investigate | 3-strike 协议、Bug 诊断 |
| 安全、密钥、生产、权限、供应链 | cso / careful / guard / freeze | `safetyGate`、BOUNDARY |
| 发布、PR、部署、线上验证 | ship / land-and-deploy / canary / setup-deploy | 发布门禁，必须用户确认 |
| 性能、回归、Web Vitals | benchmark | 性能优化能力 |
| 长任务保存和恢复 | context-save / context-restore / learn / retro | `task_plan.md`、`progress.md`、`EXPERIENCE` |
| 第二意见、跨模型挑战 | codex / benchmark-models | reviewVerificationPacket |

---

## 天火调用策略

```yaml
gstackRoutePacket:
  useGstack: true | false
  reason: ""
  mappedSkill: ""
  awknStage: ""
  riskLevel: low | medium | high
  confirmationNeeded: true | false
  evidenceRequired: []
```

调用顺序:
1. 先用 AWKN 判断当前阶段和输入契约。
2. 再判断是否需要 gstack 专项增强。
3. 只读取本索引和天火本地模式文件。
4. 需要运行真实浏览器、发布、外部网络、cookie、自动提交前，必须过 `safetyGate`。
5. 结果写入 `reviewVerificationPacket`，经验写入 `EXPERIENCE` 候选。

---

## 禁用/确认清单

| 内容 | 策略 |
|------|------|
| auto-update、setup、安装、升级 | 禁止自动运行，需用户明确授权 |
| telemetry、analytics、Supabase 上报 | 不接入天火默认流程 |
| continuous checkpoint / 自动 git commit | 默认禁用，提交/推送必须确认 |
| land-and-deploy、ship、canary 触达生产 | 高风险，必须 `Risk` 抢占 |
| cookie-import、真实浏览器会话、账号态 | 高风险，必须确认范围和用途 |
| pair-agent、ngrok、跨代理协作 | 不进入天火默认能力，需单独授权 |
| 修改 CLAUDE.md/AGENTS.md 注入路由 | 不自动执行，只能在用户要求下改 |
| gstack scripts/bin/lib/node_modules | 不复制、不运行、不作为默认依赖 |

---

## 可复制进天火的内容判定

| 类型 | 是否进入天火 | 形式 |
|------|--------------|------|
| 路由表、触发词、风险边界 | 是 | 本文件 |
| QA/review/security/ship 的方法论摘要 | 是 | 本文件 + CAPABILITY |
| gstack 原始 `SKILL.md` 大段正文 | 否 | 只在需要重新抽取时作为来源 |
| 脚本、bin、node_modules、浏览器扩展 | 否 | 保持外部，运行前另行授权 |
| 学习/复盘规则 | 是 | `EXPERIENCE/learnings` 与 `progress.md` |

