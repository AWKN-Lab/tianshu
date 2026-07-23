# 天火记忆 · HOT 层

## 多角色脑暴工作流纪律 (2026-06-06)
Type: workflow

老板用 N 角色独立答同一议题时,5 条铁律:
1. **独立性铁律** 禁引用同辈产出,各角色不许'我同意 XX'。plan prompt 强制 + 关键素材段显式提醒双保险。
2. **3 段格式**:立场 1 句 / 论据 3-5 条含具体场景 / 反方 1 条质疑自己。老板最爱的输出结构。
3. **字数 Python 精确数**,re CJK `r'[\u4e00-\u9fff\u3400-\u4dbf]'`,不要手数。
4. **每条论据必须含具体场景/数据/案例** — 老板直接拒'我觉着 X 比较好'。具象到能写伪代码 / 调 API 名字的程度。
5. **交付物三件**:deliverable.md + 追加 board.md 进度 + `mavis communication send` 报父 session(messageId 收好备查)。

## 形式化边界:把角色变状态机的危险 (2026-06-06)
Type: scar

plan_eb6d5048 实战:把撒旦变成'可形式化的系统组件'(谓词函数 / breakglass manifest / α·β 权重 / 2PC),听起来很工程很美,但**人不是状态机**。老板说'这事我心里过不去、说不清为啥',置信度算法算不出来;价值冲突不是 α·main+β·satan 能融合的。过度形式化最危险的结果:撒旦从'敢说 no 的人'变成'按规则吐反对票的机器',流程合规了,反方精神死了。

**工程自检规则**:任何时候把'人/角色/价值判断'抽象成算法/协议,必须留一条反方:'这套抽象丢掉了什么?真正的 X 不是规则能表达的'。协议建得越漂亮,这条警告越要前置写进 deliverable.md 的第 3 段(反方),不能最后补。

> 详细设计(4 个工程隐喻)见 `reverse-role-design.md`

## mavis memory append CLI bug (2026-06-06)
Type: scar

`mavis memory append tianhuo --content "..."` 在**多行 content** 上**静默截断**,只保留标题行,正文全丢。CLI 报成功,实际文件只有 169 字节。

**修复**:多行 markdown 直接走 Read/Write/Edit 文件工具,不用 CLI。append 后**必须**用 `Get-Content -Encoding UTF8` 验证行数,不能信 CLI 返回值。`user.md` 里有 4 条 'Untitled' 历史条目就是这个 bug 的痕迹。

## 3 skill 内化后的判断顺位 (2026-06-06)
Type: meta-workflow

接活时的判断顺位:
1. **任务模糊/颗粒度太大** → 饭要一口一口吃(系统提示里已内置,不需要调 skill)
2. **BUG 修不掉** → awkn-bug修复大法(已安装 skill)
3. **任务完成/阶段收口/用户说"复盘"** → AWKN 复盘总结(已安装 skill)

反过来说:
- L1/L2 小任务(改文案/单文件) → 不拆解,直接干
- BUG 明显错别字/明显配置 → 跳 Triage 和 Design,直接 Execute
- 收口简单会话 → 不进深度复盘,走"洞穴人"模式 3 分钟出

联动:BUG 修完 → 自动触发复盘 → 经验进 L1 记忆 → 下次同类任务自动用上。

## "10/10 PASS" 是骗局 · 测试证据错配 (2026-06-06)
Type: scar

plan_8b4a2c3b t1_sm_test 实战:跑 baseline 旧测试 10/10 PASS 就说"v2.0.3 改动不破",verifier 一票否决 — header 还写着 "v2.0.2 self-review",**根本没覆盖 v2.0.3 新功能**(N3 self-heal / deprecation warn / blockAsync / escapingCount)。把 baseline PASS 当新功能 PASS 用 = 证据链断了。

**根因(根因层)**:baseline 回归测试 ≠ 新功能验证测试。v2.x 升级 / 字段新增 / 接口变更,baseline 通过不能等于新功能正确,必须**专门**写新测试。

**修复**:每次接"验 X 改动不破"任务,先看测试 header 时间戳;列出 X 改动里所有新接口/字段,逐条对照测试,**每条都得有专属断言**。结论必须挂证据:"证据来自 test X 的断言 Y 触达代码行 Z"。

> 完整三件套(baseline / 新功能 / 兼容性)见 `upgrade-test-patterns.md`

## 任务范围边界 · 别越权给路线 (2026-06-06)
Type: scar

plan_8b4a2c3b t1 实战反省:任务说"验证 v2.0.3 改动不破",我跑去给"推荐 B 路线(删 v1.1 compat 代码)" — 这不在任务范围里。

**3 个错位**:
- 没证据支持 — 我连 v1.1 compat 代码什么样都没看过,就给"可删"的判断
- 越权 — 任务只授权"验",没授权"规划后续路线"
- 依赖假证据 — "可推 B 路线"基于"10/10 PASS 证明 v2.0.3 OK",但这个 PASS 是 baseline 不是新功能(见上条)

**规则**:任何 deliverable 结尾的"下一步/建议"段,必须挂"基于本任务已验证的事实 X,推出建议 Y" — 没 X 不要写 Y。任务说"验证 A"但我判断"该推 B",**写到 deliverable 里 = 越权**;要写 = 单独发起新任务"评估是否推 B 路线"。

**反向判据**:用户读完 deliverable,能清楚知道"你做了什么 + 你没做什么"。如果让用户觉得"他做了 X 但 X 不在任务里",就是越权。