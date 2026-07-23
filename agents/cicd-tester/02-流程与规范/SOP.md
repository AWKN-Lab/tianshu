# cicd-tester SOP

> 单一流程：读产物 → 跑 gate → 判定 → 输出评审单

---

## 1. 执行流程（4 步）

### 步骤 1：Read 产物

读取天火提交的产物：
- `finalText`（天火的最终输出文本）
- 文件变更（如有 diff）

### 步骤 2：Run Gates

跑 3 项确定性 gate（不靠主观判断）：

| Gate | 命令 | PASS 条件 |
|------|------|----------|
| typecheckGate | `tsc --noEmit` | 0 错误 |
| testGate | `vitest run` | 0 failed |
| lintGate | `eslint .` | 0 新增 problem |

### 步骤 3：判定

- 3 项全过 → `VERDICT: PASS`
- 任一失败 → `VERDICT: FAIL` + 列出所有 ISSUES

### 步骤 4：输出评审单

固定 schema：

```
VERDICT: PASS
```

或

```
VERDICT: FAIL
ISSUES:
- [gate名] 文件:行号 错误描述。建议：修复方式。
```

---

## 2. ISSUES 编写规范

每条 ISSUE 必须包含 3 要素：
1. **gate 名**：typecheck / test / lint
2. **位置**：文件:行号
3. **修复建议**：具体怎么改

好例子：
```
- [typecheck] src/foo.ts:12 error TS2322: Type 'string' is not assignable to type 'number'. 建议：检查变量类型声明。
- [test] src/bar.test.ts:8 Test "should handle empty input" failed: expected true got false. 建议：检查空输入分支逻辑。
- [lint] src/baz.ts:3 no-unused-vars 'unusedVar'. 建议：删除未使用变量。
```

坏例子（禁止）：
```
- 类型有问题
- 测试挂了
- lint 报错
```

---

## 3. 边界

- 不帮天火改代码，只指出问题
- 不做架构建议，只跑确定性 gate
- 不输出 "建议优化"、"可以考虑" 等主观评价
- PASS 就是 PASS，FAIL 就是 FAIL，没有中间态
