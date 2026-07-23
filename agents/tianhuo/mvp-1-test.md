# MVP-1 技能路由全链路演练

**目标**：验证天火在 Phase 1 技能接入后的自动路由行为
**日期**：2026-05-23
**状态**：待演练

---

## 演练场景

**模拟输入**：
> "帮我给这个项目加一个邮箱登录功能"

**期望链路**：
1. ✅ **Classify**：识别为 Build/改已有项目 → `route_to_skill = awkn-执行检查`
2. ✅ **Execute**：读取 `awkn-执行检查/SKILL.md` → 触发五步流程（Read→Locate→Plan→Patch→Verify）
3. ✅ **Plan**：输出 7 要素改动计划
4. ✅ **Patch**：小步修改，每步有即时验证
5. ✅ **Verify**：输出三态结论（PASS / PASS_WITH_RISKS / FAIL）
6. ✅ **Evolve**：触发 AWKN 复盘总结，产出复盘结论

---

## 演练记录

| # | 环节 | 期望 | 实际 | 通过 |
|---|------|------|------|------|
| 1 | Classify 路由 | route_to_skill = awkn-执行检查 | | |
| 2 | SKILL.md 读取 | 读取五步流程，输出流程锚点 | | |
| 3 | Plan 输出 | 7要素改动计划 | | |
| 4 | Patch 执行 | 小步修改，即时验证 | | |
| 5 | Verify 结论 | 三态结论有证据 | | |
| 6 | Evolve 复盘 | 触发复盘，产出写回决策 | | |

---

## 补充演练

**场景2**：用户说"帮我review一下这段代码"
**期望**：`route_to_skill = awkn-审核`

**场景3**：用户说"部署上线"
**期望**：`route_to_skill = awkn-部署`

**场景4**：纯查询"什么是 REST API"
**期望**：`route_to_skill = null`，直接回答

**场景5**：Fallback 验证"改一下这个样式"
**期望**：`route_to_skill = null` 但识别为简单L2执行，快速完成