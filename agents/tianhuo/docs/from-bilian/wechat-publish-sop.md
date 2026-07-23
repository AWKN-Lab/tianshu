# 微信公众号发布 SOP

**版本**: v1.0  
**创建日期**: 2026-03-22  
**适用范围**: 碧莲 (CGO) 微信公众号发布任务  
**优先级**: P0

---

## 📋 概述

本 SOP 提供两种微信公众号发布方案：

1. **方案 A：wechat-mp-hack** - 快速发布（5 分钟，推荐日常使用）
2. **方案 B：Playwright** - 定制发布（30 分钟，支持定时发送）

---

## 🎯 方案选择

### 方案 A：wechat-mp-hack（推荐）

**适用场景**:
- ✅ 快速发布文章
- ✅ 日常内容更新
- ✅ 群发消息
- ✅ 无需定时发送

**特点**:
- ⏱️ 5 分钟完成
- 🔐 扫码登录，自动保存 session
- 📝 发布记录自动保存
- 💰 无需微信认证

### 方案 B：Playwright

**适用场景**:
- ⏰ 定时发送（如今晚 8 点）
- 🔄 需要自动重试
- 🌐 多浏览器支持
- 🛠️ 定制化需求

**特点**:
- ⏱️ 30 分钟配置
- 🔐 Cookie 持久化（参考小红书）
- 🔄 失败自动重试 3 次
- ⏰ 支持定时发送

---

## 🚀 方案 A：wechat-mp-hack 发布流程

### 步骤 1：检查登录状态

```javascript
const WechatMpHackPublisher = require('by-platform/wechat/wechat-publisher/wechat-mp-hack-integration');
const publisher = new WechatMpHackPublisher();

// 检查登录状态
const status = publisher.checkLoginStatus();
console.log('登录状态:', status);

// 如未登录，调用 init() 扫码
if (!status.isLoggedIn) {
  await publisher.init();
  // 控制台输出二维码 URL
  // 使用微信扫码登录
  // 登录成功后自动保存 session
}
```

### 步骤 2：准备文章内容

```javascript
const article = {
  title: 'AI Agent 实战指南',           // 标题 ≤23 字
  content: '<h1>AI Agent 实战指南</h1><p>正文内容...</p>', // HTML 格式
  author: '碧莲',                       // 作者名（可选）
  digest: '文章摘要',                   // 摘要 ≤54 字（可选，自动生成）
  cover: './cover.jpg'                 // 封面图路径（可选）
};
```

**内容要求**:
- 标题：≤23 字
- 内容：HTML 格式（从 `wechat-writing-suite` 获取）
- 封面：900x383px（2.35:1），可选
- 摘要：≤54 字，可选（自动生成）

### 步骤 3：发布文章

```javascript
const result = await publisher.publish(article);

console.log('发布成功!');
console.log('文章链接:', result.url);
console.log('Media ID:', result.mediaId);
console.log('发布时间:', new Date(result.timestamp).toLocaleString('zh-CN'));
```

**自动功能**:
- ✅ 自动保存发布记录到 `data/publish-records.json`
- ✅ 自动返回文章链接和 mediaId

### 步骤 4：验证发布结果

```javascript
// 检查发布记录
const records = publisher.getPublishRecords(10);
console.log('最近发布记录:', records);

// 验证文章是否可访问
console.log('文章 URL:', records[0].result.url);
```

---

## 🚀 方案 B：Playwright 发布流程

### 步骤 1：检查登录状态

```javascript
const WechatAutoPublisher = require('by-platform/wechat/wechat-auto/index');
const publisher = new WechatAutoPublisher({
  headless: false,  // 显示浏览器，方便扫码
  browserType: 'chromium'
});

// 检查登录状态
const status = await publisher.checkLoginStatus();
console.log('登录状态:', status);

// 如未登录，调用 login() 扫码
if (!status.isLoggedIn) {
  await publisher.login();
  // 扫码登录，自动保存 Cookie
}
```

### 步骤 2：准备文章内容

```javascript
const article = {
  title: 'AI Agent 实战指南',                    // 标题 ≤23 字
  content: '# AI Agent 实战指南\n\n正文内容...',  // Markdown 格式（自动转 HTML）
  digest: '文章摘要',                           // 摘要 ≤54 字
  cover: './cover.jpg',                        // 封面图路径（可选）
  scheduledAt: '2026-03-22T20:00:00+08:00'     // 定时发送时间（可选，ISO 8601）
};
```

**内容要求**:
- 标题：≤23 字
- 内容：Markdown 格式（自动转换为 HTML）
- 封面：本地图片路径
- 摘要：≤54 字
- 定时时间：ISO 8601 格式（如 `'2026-03-22T20:00:00+08:00'`）

### 步骤 3：发布文章（带自动重试）

```javascript
const result = await publisher.publish(article);

console.log('发布成功!');
console.log('文章链接:', result.url);
console.log('Media ID:', result.mediaId);
```

**自动功能**:
- ✅ 失败自动重试 3 次（间隔 5 秒）
- ✅ 自动保存发布记录
- ✅ 自动转换 Markdown 为 HTML

### 步骤 4：验证发布结果

```javascript
// 检查发布记录
const records = publisher.getPublishRecords(10);
console.log('最近发布记录:', records);

// 验证定时发送
if (article.scheduledAt) {
  console.log('定时发送时间:', article.scheduledAt);
  console.log('预计发送时间:', new Date(article.scheduledAt).toLocaleString('zh-CN'));
}
```

---

## 🐛 故障排查

### 问题 1：扫码登录超时

**现象**: 控制台输出 "登录超时"

**解决**:
```bash
# 删除 session/cookie 文件
rm ./data/wechat-session.json        # 方案 A
rm ./data/wechat-login-state.json    # 方案 B

# 重新扫码
node test-publish.js
```

### 问题 2：发布失败

**检查清单**:
- [ ] 登录状态是否有效
- [ ] 发布配额是否用完（订阅号每天 1 次，服务号每月 4 次）
- [ ] 内容是否合规（无敏感词）
- [ ] 网络连接是否正常

**解决**:
```javascript
try {
  await publisher.publish(article);
} catch (error) {
  console.error('发布失败详情:', error);
  
  if (error.message.includes('登录已过期')) {
    // 重新登录
    await publisher.restart();  // 方案 A
    await publisher.login();    // 方案 B
  }
}
```

### 问题 3：找不到文件

**现象**: `Cannot find module`

**解决**:
```bash
# 确认路径正确
cd c:\Users\10919\Desktop\AI\skills\by-platform\wechat

# 检查文件是否存在
ls wechat-publisher/wechat-mp-hack-integration.js
ls wechat-auto/index.js
```

---

## 💡 最佳实践

### 1. 日常使用

```javascript
// 每天首次使用检查登录状态
const status = publisher.checkLoginStatus();
if (!status.isLoggedIn) {
  await publisher.init();  // 或 await publisher.login()
}

// 直接发布
await publisher.publish(article);
```

### 2. 内容准备

```javascript
// 使用 wechat-writing-suite 生成内容
const content = await generateWechatContent(topic);

// 生成封面图
const cover = await generateCoverImage(title);

// 生成摘要
const digest = content.substring(0, 54) + '...';
```

### 3. 发布记录

```javascript
// 查看最近发布
const records = publisher.getPublishRecords(7);
records.forEach(record => {
  console.log(`${record.title} - ${record.result.url}`);
});
```

---

## 📊 发布记录管理

### 文件位置

- **方案 A**: `skills/by-platform/wechat/wechat-publisher/data/publish-records.json`
- **方案 B**: `skills/by-platform/wechat/wechat-auto/data/publish-records.json`

### 记录格式

```json
{
  "title": "文章标题",
  "content": "...",
  "cover": "...",
  "result": {
    "url": "https://mp.weixin.qq.com/s/xxx",
    "mediaId": "media_xxx",
    "success": true
  },
  "timestamp": 1234567890
}
```

### 查询记录

```javascript
// 获取最近 10 条
const records = publisher.getPublishRecords(10);

// 获取所有记录
const allRecords = publisher.getPublishRecords(100);

// 按日期筛选
const todayRecords = records.filter(r => {
  const date = new Date(r.timestamp);
  return date.toDateString() === new Date().toDateString();
});
```

---

## 🔧 配置选项

### 方案 A：wechat-mp-hack

```javascript
const publisher = new WechatMpHackPublisher({
  sessionPath: './data/wechat-session.json',  // 自定义 session 路径
  autoSaveSession: true,                       // 自动保存 session
});
```

### 方案 B：Playwright

```javascript
const publisher = new WechatAutoPublisher({
  browserType: 'chromium',      // chromium/firefox/webkit
  headless: false,              // 显示浏览器
  slowMo: 100,                  // 慢动作（调试用）
  maxRetries: 3,                // 最大重试次数
  timeout: 120000,              // 超时时间（ms）
  loginStatePath: './data/wechat-login-state.json'  // Cookie 路径
});
```

---

## 📚 相关文档

- **完整使用指南**: `skills/by-platform/wechat/README-COMPLETE.md`
- **wechat-mp-hack 文档**: `skills/by-platform/wechat/wechat-publisher/README-mp-hack.md`
- **实施总结**: `skills/by-platform/wechat/IMPLEMENTATION-SUMMARY.md`

---

## ✅ 检查清单

### 发布前检查

- [ ] 登录状态有效
- [ ] 标题 ≤23 字
- [ ] 内容已审核（无敏感词）
- [ ] 封面图尺寸正确（900x383px）
- [ ] 摘要 ≤54 字
- [ ] 发布配额未用完

### 发布后验证

- [ ] 返回成功结果
- [ ] 文章链接可访问
- [ ] 发布记录已保存
- [ ] 数据已记录到内容日历

---

*版本：v1.0*  
*创建时间：2026-03-22*  
*维护者：碧莲 (CGO)*
