# EXP-029: 多Provider Fallback增强模式

> **经验等级**: S级
> **来源项目**: 大宗师项目（人生决策宗师）
> **提取时间**: 2026-04-22
> **适用场景**: LLM API调用、第三方服务依赖

---

## 核心洞察

**问题**: 依赖单一LLM Provider的风险：
- API限流/宕机时服务不可用
- 成本波动导致业务不稳定
- 无法应对突发流量

**新方案**: 优先级链式Fallback + 熔断机制
- 正常情况：优先使用最高性价比的Provider
- 异常情况：自动切换到备选Provider
- 极端情况：触发熔断保护，避免资源浪费

---

## 大宗师项目的Provider配置

```yaml
# LLM Provider优先级配置
providers:
  - name: doubao
    apiKey: ${DOUBAO_API_KEY}
    baseUrl: https://ark.cn-beijing.volces.com/api/v3
    model: Doubao-pro
    priority: 1  # 最高优先级
    timeout: 30000
    retry: 2

  - name: minimax
    apiKey: ${MINIMAX_API_KEY}
    baseUrl: https://api.minimax.chat/v1
    model: MiniMax-Text-01
    priority: 2
    timeout: 30000
    retry: 2

  - name: moonshot
    apiKey: ${MOONSHOT_API_KEY}
    baseUrl: https://api.moonshot.cn/v1
    model: moonshot-v1-8k
    priority: 3
    timeout: 30000
    retry: 2

  - name: openai
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
    priority: 4  # 最低优先级（兜底）
    timeout: 30000
    retry: 2
```

---

## Fallback执行流程

```
用户请求
    │
    ▼
┌─────────────────┐
│ 尝试Provider 1  │
│ (doubao)        │
└─────────────────┘
    │
    ├── 成功 → 返回结果
    │
    └── 失败（超时/限流/错误）
            │
            ▼
    ┌─────────────────┐
    │ 尝试Provider 2  │
    │ (minimax)       │
    └─────────────────┘
            │
            ├── 成功 → 返回结果
            │
            └── 失败
                    │
                    ▼
            ┌─────────────────┐
            │ 尝试Provider 3  │
            │ (moonshot)     │
            └─────────────────┘
                    │
                    ├── 成功 → 返回结果
                    │
                    └── 失败
                            │
                            ▼
                    ┌─────────────────┐
                    │ 尝试Provider 4  │
                    │ (openai)        │
                    └─────────────────┘
                            │
                            ├── 成功 → 返回结果
                            │
                            └── 失败 → 触发熔断
                                    │
                                    ▼
                            ┌─────────────────┐
                            │ 返回错误/降级   │
                            └─────────────────┘
```

---

## 熔断机制

### 熔断触发条件

| 指标 | 阈值 | 说明 |
|------|------|------|
| 错误率 | >30% | 10次请求中>3次失败 |
| 响应时间 | >60s | P95响应时间超过60秒 |
| 连续失败 | 5次 | Provider连续失败5次 |

### 熔断执行动作

```typescript
// 熔断器实现
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async call(provider: Provider, request: Request): Promise<Response> {
    // 熔断开启状态
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > RECOVERY_TIMEOUT) {
        this.state = 'HALF_OPEN';  // 半开状态，尝试恢复
      } else {
        throw new CircuitOpenError(`${provider.name} circuit is open`);
      }
    }

    try {
      const response = await provider.call(request);
      this.onSuccess();
      return response;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= FAILURE_THRESHOLD) {
      this.state = 'OPEN';  // 熔断开启
    }
  }
}
```

---

## 关键设计原则

### 原则1: Provider按性价比排序

```
优先级 = f(价格, 速度, 稳定性, 模型能力)

# 大宗师项目的实际排序
1. doubao: 性价比最高，作为主Provider
2. minimax: 备选，能力接近
3. moonshot: 再次备选
4. openai: 兜底，只有前三个都失败才用
```

### 原则2: 每个Provider独立熔断

```
Provider A 熔断 → 不影响 Provider B/C/D
- doubao熔断 → 立即切换到minimax
- minimax熔断 → 继续尝试moonshot
- moonshot熔断 → 最后尝试openai
```

### 原则3: 熔断恢复需要探测

```typescript
// 半开状态：允许一个请求通过，测试是否恢复
if (this.state === 'HALF_OPEN') {
  const testRequest = await provider.call(testRequest);
  if (testRequest.success) {
    this.state = 'CLOSED';  // 恢复正常
  } else {
    this.state = 'OPEN';  // 继续保持熔断
  }
}
```

### 原则4: 请求日志必须记录Provider信息

```typescript
// 每个请求记录使用的Provider
const logEntry = {
  requestId: uuid(),
  provider: 'doubao',      // 实际使用的Provider
  providerPriority: 1,     // 优先级
  fallbackCount: 0,        // Fallback次数
  latency: 1234,          // 响应时间ms
  status: 'success',      // 成功/失败/fallback
  error: null             // 错误信息
};
```

---

## 配置管理

### 环境变量配置

```bash
# .env 文件配置
DOUBAO_API_KEY=your_key_here
MINIMAX_API_KEY=your_key_here
MOONSHOT_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here

# API Base URLs
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
MINIMAX_BASE_URL=https://api.minimax.chat/v1
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
```

### 密钥安全原则

1. **密钥不进代码** - 永远从环境变量读取
2. **密钥不进仓库** - .env文件加入.gitignore
3. **密钥不进日志** - 日志中只记录Provider名称，不记录密钥
4. **密钥定期轮换** - 每季度更换一次API Key

---

## 监控指标

| 指标 | 告警阈值 | 说明 |
|------|----------|------|
| Provider可用率 | <95% | 单Provider成功率低于95% |
| 平均Fallback次数 | >0.5 | 平均每次请求需要Fallback |
| 熔断次数 | >10次/小时 | 熔断过于频繁 |
| P95响应时间 | >30s | 用户等待时间过长 |

---

## 迁移到天火智能体

**适用场景扩展**:
- 搜索服务: 百度→Google→Bing
- 文件存储: 腾讯COS→阿里OSS→AWS S3
- 消息推送: 邮件→短信→Push

**核心原则**:
> 任何外部依赖都必须有Fallback，永远不要依赖单一服务。

---

## 下次遇到类似情况，先做哪3件事？

1. 分析外部依赖的可替代性
2. 设计Fallback优先级链
3. 配置熔断阈值和恢复策略
