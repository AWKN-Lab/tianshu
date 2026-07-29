# Review Kernel 基线与上线手册

## 当前交付状态

Runtime 契约、Planner、Reviewer、Finding Validator、Coverage/Verdict、Receipt、Native Git/OCR Adapter、AgentLoop、Gate、直接工具、shadow Receipt 与引擎内最小 Go producer 已实现。真实 30–50 仓库样本的双人标注、Shadow 观测和发布二进制摘要固定仍属于发布工作，不以设计样本或单元测试冒充；任何外部 OCR checkout 都不是交付物或运行依赖。

## 基线语料

建立 36 个编号样本，至少覆盖：单文件正确性、跨文件契约、Schema/Migration、Producer/Consumer、配置、权限、PRD/Spec、公共类型、错误处理、i18n、测试作弊、安全、rename/delete/binary/generated、空/大 Diff、中文/空格路径、目标变化、Provider/模型故障和非法输出。

每个样本应保存：仓库 bundle 或生成脚本、base/head OID、目标指纹、人工 Finding、阻断级别、允许排除项和标注 Actor。样本未经双人标注不得进入评分集。

## 指标口径

- Critical/High 召回率：被新链路命中的人工阻断 Finding / 全部人工阻断 Finding。
- Finding 精确率：人工确认有效的新 Finding / 全部新 Finding。
- 位置有效率：可在冻结 Diff 精确定位的 Critical/High / 全部 Critical/High。
- 文件覆盖率和风险覆盖率：直接读取 Review Coverage，禁止按模型调用次数估算。
- 安全误 PASS：旧链路或人工基准有阻断项、结构化 Verdict 却为 PASS 的样本数。

## 上线顺序

1. `0`：确认兼容路径不变。
2. `shadow`：Runtime 与核心技能目录，旧 Gate 权威；聚合 REVIEW/SHADOW_DIFF。
3. 达到 ADR 硬门槛且连续两个周期无 P0/P1 后，白名单 `enforce`。
4. 扩大到核心技能和全仓；保留一个发布周期回退开关。
5. 删除自然语言 Verdict 的权威路径。

`SAFETY_REGRESSION`（旧 FAIL、新 PASS）必须人工处理并阻止 enforce；`EXPECTED_IMPROVEMENT`（旧 PASS、新非 PASS）进入误报校准；`EXACT` 用于一致性趋势，不能单独证明质量。

## 故障演练

每次候选发布必须注入 OCR 缺失/版本错/Hash 错/非法 JSON/重复 key/超时/断进程、Reviewer 超时/非法输出/自改自审、Finding 越界/伪造 Evidence、Diff 审核中变化和单元漏审。预期结果只能是 FAIL、PARTIAL、STALE 或 INVALID，绝不能 PASS。
