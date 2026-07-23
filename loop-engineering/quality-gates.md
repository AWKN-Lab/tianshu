# 质量门禁定义

> 版本：v1.0 ｜ 日期：2026-07-09 ｜ 状态：设计稿

## 结论先行

7 个 gate 拦截每一轮 Turn。L2 停止条件默认 4 项标准集：类型检查 0 错误 + 测试 0 failed + lint 0 新增 + 审核 PASS。循环里必须有"说不"的（铁律 2），gate 失败即反馈 Agent 重试。

---

## 一、7 个 Gate 总览

| # | Gate 名 | 检查项 | 不通过动作 | 在 Loop 中的位置 |
|---|---------|-------|----------|----------------|
| 1 | typecheckGate | 类型检查 0 错误 | 反馈 Agent 重试 | 每轮 Execute 后 |
| 2 | testGate | 测试 0 failed | 反馈 Agent 重试 | 每轮 Execute 后 |
| 3 | lintGate | lint 0 新增 | 反馈 Agent 重试 | 每轮 Execute 后 |
| 4 | reviewGate | 审核 PASS | 反馈 Agent 重试 | 每轮或每 N 轮 |
| 5 | securityGate | 安全扫描 0 高危 | 反馈 Agent 重试 | 关键改动后 |
| 6 | verificationGate | 五步执行检查通过 | 反馈 Agent 重试 | 每轮 Execute 后 |
| 7 | budgetGate | token 不超限 | 触发 3-strike 协议 | 每轮开始 + 结束 |

---

## 二、各 Gate 详细定义

### 2.1 typecheckGate

| 项 | 内容 |
|----|------|
| 名称 | typecheckGate |
| 检查项 | 类型检查 0 错误 |
| 检查命令（TS） | `tsc --noEmit` |
| 检查命令（Python） | `mypy src/` 或 `pyright src/` |
| 检查命令（Go） | `go vet ./...` |
| 检查命令（Rust） | `cargo check` |
| 不通过动作 | 错误列表反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | 每轮 Execute 后，第一个执行的 gate |
| 超时 | 60s |

### 2.2 testGate

| 项 | 内容 |
|----|------|
| 名称 | testGate |
| 检查项 | 测试 0 failed |
| 检查命令（Node） | `pnpm test` 或 `npm test` |
| 检查命令（Python） | `pytest` |
| 检查命令（Go） | `go test ./...` |
| 检查命令（Rust） | `cargo test` |
| 不通过动作 | 失败用例列表反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | typecheckGate 之后 |
| 超时 | 300s |

### 2.3 lintGate

| 项 | 内容 |
|----|------|
| 名称 | lintGate |
| 检查项 | lint 0 **新增**（基线对比） |
| 检查命令（TS/JS） | `eslint . --fix-dry-run` + 与基线 diff |
| 检查命令（Python） | `ruff check .` |
| 检查命令（Go） | `golangci-lint run` |
| 检查命令（Rust） | `clippy` |
| 不通过动作 | 新增违规列表反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | testGate 之后 |
| 超时 | 60s |
| 备注 | 只拦"新增"，历史问题不阻塞 |

### 2.4 reviewGate

| 项 | 内容 |
|----|------|
| 名称 | reviewGate |
| 检查项 | 审核 PASS |
| 检查命令 | 调用 `awkn-审核` 技能 |
| 不通过动作 | 审核意见反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | lintGate 之后；或每 N 轮一次（默认 N=3） |
| 超时 | 120s |
| 备注 | 第二 agent review，铁律 2 的"说不"担当 |

### 2.5 securityGate

| 项 | 内容 |
|----|------|
| 名称 | securityGate |
| 检查项 | 安全扫描 0 高危 |
| 检查命令 | `awkn-审核` 安全子项 / `npm audit` / `pip-audit` |
| 不通过动作 | 高危项列表反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | 关键改动后（依赖变更、认证逻辑、IO 处理） |
| 超时 | 90s |

### 2.6 verificationGate

| 项 | 内容 |
|----|------|
| 名称 | verificationGate |
| 检查项 | 五步执行检查通过（R→L→P→P→V） |
| 检查命令 | 调用 `awkn-执行检查` 技能 |
| 不通过动作 | 未通过步骤反馈给 Agent，进入下一轮 |
| 在 Loop 中的位置 | 每轮 Execute 后，与 typecheckGate 并联 |
| 超时 | 90s |

### 2.7 budgetGate

| 项 | 内容 |
|----|------|
| 名称 | budgetGate |
| 检查项 | 累计 token ≤ 预算 |
| 检查命令 | 运行时 token 计数器 |
| 不通过动作 | 触发 3-strike 协议（见 token-strategy.md） |
| 在 Loop 中的位置 | 每轮开始 + 每轮结束 |
| 超时 | 即时 |

---

## 三、L2 停止条件默认标准集

L2 Goal Loop 默认要求以下 4 项**全部通过**才算达成目标。

| # | 检查项 | 默认值 | 对应 Gate | 按语言适配 |
|---|-------|-------|----------|----------|
| 1 | 类型检查 | 0 错误 | typecheckGate | TS: tsc / Python: mypy 或 pyright / Go: go vet / Rust: cargo check |
| 2 | 测试 | 0 failed | testGate | Node: pnpm test / Python: pytest / Go: go test / Rust: cargo test |
| 3 | lint | 0 新增 | lintGate | TS/JS: eslint / Python: ruff / Go: golangci-lint / Rust: clippy |
| 4 | 审核 | PASS | reviewGate | 调用 awkn-审核 技能 |

### 停止判定逻辑

```
停止 = typecheckGate PASS
     AND testGate PASS
     AND lintGate PASS
     AND reviewGate PASS
     AND 未超 max-rounds
     AND 未超 budget
```

### 用户覆盖

| 用户指令 | 效果 |
|---------|------|
| `--stop default` | 用上述 4 项 |
| `--stop testGate` | 只看测试 |
| `--stop typecheckGate,reviewGate` | 类型 + 审核 |
| `--stop none` | 不设停止条件（仅 L3 巡检用） |

---

## 四、循环里"说不"的铁律说明

**铁律 2**：循环里必须有"说不"的。

### 为什么

Agent 在 Loop 里会倾向于"我觉得改好了"。没有外部"说不"的声音，Loop 会假收敛——表面通过，实际没达成。

### "说不"的担当

| 担当 | 形式 | 对应 Gate |
|------|------|----------|
| 测试 | 测试用例失败 | testGate |
| 类型检查 | 编译器报错 | typecheckGate |
| lint | 静态分析违规 | lintGate |
| 第二 agent | awkn-审核 拒绝 | reviewGate |
| 安全扫描 | 高危项 | securityGate |
| 执行检查 | 五步未过 | verificationGate |
| 预算 | token 超限 | budgetGate |

### 强制要求

| 规则 | 说明 |
|------|------|
| 至少一个 | 每个 Loop 至少配置一个"说不"的 gate |
| 推荐 reviewGate | L2 默认集必须含 reviewGate，第二 agent 是最强"说不" |
| 禁止只有自述 | 不能仅凭 Agent 自己说"完成"就停 |

---

## 五、门禁组合规则

### 5.1 串联（顺序执行，前一个 FAIL 则短路）

| 链 | 顺序 | 说明 |
|----|------|------|
| 静态检查链 | typecheckGate → lintGate | 先类型后 lint，类型错时 lint 无意义 |
| 完整 L2 链 | typecheckGate → testGate → lintGate → reviewGate | L2 默认停止集 |

### 5.2 并联（同时执行，任一 FAIL 即失败）

| 组 | 并联项 | 说明 |
|----|-------|------|
| 改动验证组 | verificationGate ∥ typecheckGate | 互不依赖，并行省时 |
| 安全组 | securityGate ∥ reviewGate | 安全和审核独立判断 |

### 5.3 全局组合图

```
每轮 Execute 后：
  [并联组 A]
    ├── typecheckGate
    └── verificationGate
        ↓ 全 PASS
  [串联链 B]
    testGate → lintGate
        ↓ 全 PASS
  [并联组 C]
    ├── reviewGate
    └── securityGate（仅关键改动）
        ↓ 全 PASS
  本轮通过，进入下一轮或停止判定
```

### 5.4 budgetGate 独立

budgetGate 不在上述组合里，**每轮开始和结束各检查一次**，超限直接触发 3-strike，不走 gate 链。

---

## 六、Gate 失败的处理动作

| 失败次数 | 动作 |
|---------|------|
| 1-2 次 | 反馈错误给 Agent，下一轮重试 |
| 连续 3 次同一 gate | 标记卡点，触发 escalation（换 Skill 或降级） |
| 达到 max-rounds | 停止 Loop，标记未达成，调用 awkn-复盘总结 |
| budgetGate 触发 | 走 3-strike 协议（见 token-strategy.md） |

---

## 七、Gate 配置示例

### L2 默认配置

| Gate | 启用 | 位置 |
|------|------|------|
| typecheckGate | ✓ | 每轮 |
| testGate | ✓ | 每轮 |
| lintGate | ✓ | 每轮 |
| reviewGate | ✓ | 每 3 轮 |
| securityGate | 仅关键改动 | 按需 |
| verificationGate | ✓ | 每轮 |
| budgetGate | ✓ | 每轮开始+结束 |

### L3 巡检配置（轻量）

| Gate | 启用 | 位置 |
|------|------|------|
| typecheckGate | ✓ | 每次触发 |
| testGate | ✓ | 每次触发 |
| lintGate | ✗ | — |
| reviewGate | ✗ | — |
| securityGate | ✓ | 每次触发 |
| verificationGate | ✗ | — |
| budgetGate | ✓ | 每次 |

### L4 自治配置（严格）

| Gate | 启用 | 位置 |
|------|------|------|
| 全部 | ✓ | 每轮 + 关键节点 |
| reviewGate | ✓ | 每轮（不降频） |
| budgetGate | ✓ | 每轮 + 阶段切换时 |

---

## 八、Gate 与技能的对接

| Gate | 直接跑命令 | 调用技能 |
|------|----------|---------|
| typecheckGate | ✓ | — |
| testGate | ✓ | — |
| lintGate | ✓ | — |
| reviewGate | — | awkn-审核 |
| securityGate | 部分 | awkn-审核（安全子项） |
| verificationGate | — | awkn-执行检查 |
| budgetGate | ✓（运行时内置） | — |

详见 `skill-registry-loop.md`。
