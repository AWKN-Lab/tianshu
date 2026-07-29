---
name: awkn-spec
description: AWKN 冻结类技能合集 - 产品想法定位、技术方案冻结、0→1 编排。把 0→1 阶段最容易返工的口径一次性定死。
protection: 🟡
version: 1.0.0
author: AWKN
triggers:
  - keyword: 一句话定位
  - keyword: 想法冻结
  - keyword: idea-freeze
  - keyword: 技术方案冻结
  - keyword: tech-freeze
  - keyword: 0→1
  - keyword: 从零到一
  - keyword: 新产品立项
---

# awkn-spec（冻结类技能合集）

## 它是什么
把 0→1 阶段最容易返工的口径一次性定死：想法定位、技术方案、完整编排。
**不直接做执行**，只负责规定顺序、交付物、通过标准、停机条件。

## 子技能路由

| 触发场景 | 调用子技能 | 何时用 |
|----------|----------|--------|
| 有新想法，要定方向盘 | `awkn-spec/idea-freeze-spec` | 写 PRD 之前 |
| MVP 确定后，开始写代码/套壳前 | `awkn-spec/tech-freeze-spec` | 联调反复返工时 |
| 0→1 全流程编排 | `awkn-spec/zero-to-one-orchestrator` | 新产品立项时 |

## 与其他技能的关系

| 上游（必须先做） | 中游（本套件） | 下游（完成后再做） |
|----------------|--------------|------------------|
| — | `awkn-spec/idea-freeze-spec` | `awkn-创新经理/skills/validate`（用户验证） |
| — | `awkn-spec/tech-freeze-spec` | `awkn-程序员天阶功法`（工程落地） |
| — | `awkn-spec/zero-to-one-orchestrator`（路由器） | 串接上面 3 个 |

**注意**：
- **awkn-程序员天阶功法** 中 `01_01_立项定位与边界冻结.md` 和 `02_01_技术方案冻结与关键口径.md` 已包含等价内容，作为双写/备份入口
- **awkn-创新经理/validate** 已吸收 validation-kit 的 10 题访谈+Go/Stop/Pivot 判定规则

## 强制规则

- OR1：必须按 idea-freeze → validate → prd → tech-freeze 顺序执行
- OR2：任一步无结果单或结果单不完整，禁止进入下一步
- OR3：tech-freeze-spec 通过前，禁止大规模开发
- OR4：所有变更必须升版本（v1→v2），不允许口头改

## 启动口令

- "启动 awkn-spec：做 0→1 编排，形态【小程序/H5】"
- "启动 idea-freeze-spec：我有新想法【___】"
- "启动 tech-freeze-spec：MVP 已定，准备冻结技术方案"
