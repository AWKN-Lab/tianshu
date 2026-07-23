/**
 * M3 进阶-19/20/21 端到端验证：LLM providers + skills parser 隐藏 bug 修复
 *
 * 核心验证 3 个 bug 修复：
 * - 进阶-19：trae.ts hook 返回空 content → fail-closed 跳过（不当作成功）
 * - 进阶-20：trae.ts fileBridge 资源泄漏 → cleanupBridge 统一清理 req+resp
 * - 进阶-21：parser.ts parseDependencies 正则 CRLF 不一致 → 统一 \r?\n
 *
 * 验证点：
 * 1. 静态：trae.ts 含 fail-closed 空 content 校验
 * 2. 静态：trae.ts 含 cleanupBridge 统一清理 + 所有出口调用（≥4 处）
 * 3. 静态：parser.ts 含 \r?\n 正则（CRLF 支持）
 * 4. 单元：parseSkillFile 支持 CRLF frontmatter
 * 5. 单元：parseDependencies 支持 CRLF（通过 parseSkillFile 间接验证 dependencies 解析）
 * 6. 端到端：空 content hook 被跳过，有效 content hook 被采用
 * 7. 端到端：纯空白 content hook 也被跳过（fail-closed）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '../src/skills/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 临时桥接目录（端到端测试用，动态 import 前设置）
const tmpBridgeDir = resolve(__dirname, '..', 'data', `verify-bridge-${Date.now()}`);

describe('M3 进阶-19/20/21: LLM providers + skills parser 隐藏 bug 修复', () => {
  // ========== 静态结构验证 ==========

  it('静态：trae.ts 含 fail-closed 空 content 校验（M3 进阶-19）', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'llm', 'providers', 'trae.ts'),
      'utf-8',
    );
    assert.ok(src.includes('M3 进阶-19'), '应含 M3 进阶-19 注释');
    assert.ok(src.includes('empty llmResponse.content'), '应含空 content 校验');
    assert.ok(src.includes("content.trim() === ''"), '应含 trim() 空白检查');
    assert.ok(src.includes('fail-closed'), '应含 fail-closed 关键字');
    // 确保跳过逻辑存在（continue，不是 return）
    assert.ok(src.includes('continue;'), '空 content 时应 continue 跳过');
  });

  it('静态：trae.ts 含 cleanupBridge 统一清理 + 所有出口调用（M3 进阶-20）', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'llm', 'providers', 'trae.ts'),
      'utf-8',
    );
    assert.ok(src.includes('M3 进阶-20'), '应含 M3 进阶-20 注释');
    assert.ok(src.includes('cleanupBridge'), '应含 cleanupBridge 函数');
    assert.ok(src.includes('const cleanupBridge = (): void =>'), '应定义 cleanupBridge');

    // 统计 cleanupBridge() 调用次数（应在 ≥4 个出口：写失败/成功/换行修复成功/parse失败/timeout）
    const callCount = (src.match(/cleanupBridge\(\)/g) || []).length;
    // 1 定义 + ≥4 调用 = ≥5
    assert.ok(callCount >= 5, `cleanupBridge 应被定义+调用 ≥5 次（1 定义 + ≥4 调用），实际 ${callCount} 次`);

    // 验证 unlinkSync(reqPath) 只出现在 cleanupBridge 定义内部（1 处），无其他零散调用
    const standaloneUnlink = (src.match(/try \{ unlinkSync\(reqPath\)/g) || []).length;
    assert.equal(standaloneUnlink, 1, 'unlinkSync(reqPath) 只应在 cleanupBridge 定义内出现 1 次，无零散调用');
  });

  it('静态：parser.ts 含 \\r?\\n 正则（CRLF 支持，M3 进阶-21）', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'skills', 'parser.ts'),
      'utf-8',
    );
    assert.ok(src.includes('M3 进阶-21'), '应含 M3 进阶-21 注释');
    // parseDependencies 的正则应支持 \r?\n
    assert.ok(src.includes('/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/'), 'parseDependencies frontmatter 正则应支持 CRLF');
    assert.ok(src.includes('dependencies:\\s*\\r?\\n'), 'dependencies section 正则应支持 CRLF');
  });

  // ========== 单元验证：parser CRLF 支持 ==========

  it('单元：parseSkillFile 支持 CRLF frontmatter（M3 进阶-21）', () => {
    // 构造 CRLF 行尾的 SKILL.md
    const crlfContent = [
      '---',
      'name: crlf-test-skill',
      'version: 1.0.0',
      'description: test skill with CRLF line endings',
      'proactive: false',
      'dependencies:',
      '  - env_var:CRLF_VAR',
      '---',
      '',
      '# CRLF Test Skill Body',
      '',
      'Some content here.',
    ].join('\r\n');

    const parsed = parseSkillFile(crlfContent);
    assert.equal(parsed.meta.name, 'crlf-test-skill', 'name 应正确解析');
    assert.equal(parsed.meta.version, '1.0.0', 'version 应正确解析');
    assert.equal(parsed.meta.description, 'test skill with CRLF line endings', 'description 应正确解析');
    assert.ok(parsed.body.includes('# CRLF Test Skill Body'), 'body 应正确解析');
  });

  it('单元：parseDependencies 支持 CRLF（dependencies 不静默丢失，M3 进阶-21）', () => {
    // 构造含 dependencies 的 CRLF SKILL.md
    const crlfContent = [
      '---',
      'name: dep-test-skill',
      'dependencies:',
      '  - env_var:REQUIRED_VAR',
      '  - mcp_server:fs_server?',
      '  - tool:read',
      '---',
      '',
      'body',
    ].join('\r\n');

    const parsed = parseSkillFile(crlfContent);
    assert.ok(parsed.meta.dependencies.length >= 3, `应解析 ≥3 个依赖，实际 ${parsed.meta.dependencies.length}`);

    const envDep = parsed.meta.dependencies.find((d) => d.name === 'REQUIRED_VAR');
    assert.ok(envDep, '应找到 REQUIRED_VAR 依赖');
    assert.equal(envDep!.type, 'env_var', 'REQUIRED_VAR 类型应为 env_var');
    assert.equal(envDep!.required, true, 'REQUIRED_VAR 应为 required');

    const mcpDep = parsed.meta.dependencies.find((d) => d.name === 'fs_server');
    assert.ok(mcpDep, '应找到 fs_server 依赖');
    assert.equal(mcpDep!.type, 'mcp_server', 'fs_server 类型应为 mcp_server');
    assert.equal(mcpDep!.required, false, 'fs_server 应为 optional（带 ?）');
  });

  it('单元：LF 行尾的 SKILL.md 仍然正常工作（不回归）', () => {
    const lfContent = [
      '---',
      'name: lf-test-skill',
      'dependencies:',
      '  - env_var:LF_VAR',
      '---',
      '',
      'body',
    ].join('\n');

    const parsed = parseSkillFile(lfContent);
    assert.equal(parsed.meta.name, 'lf-test-skill', 'LF: name 应正确解析');
    const dep = parsed.meta.dependencies.find((d) => d.name === 'LF_VAR');
    assert.ok(dep, 'LF: 应找到 LF_VAR 依赖');
  });

  // ========== 端到端验证：trae.ts hook fail-closed ==========

  let TraeProvider: typeof import('../src/llm/providers/trae.js').TraeProvider;
  let hookManager: typeof import('../src/core/hook-manager.js').hookManager;
  const registeredHookIds: string[] = [];

  before(async () => {
    // 设置 BRIDGE_DIR 为临时目录（动态 import 前设置）
    process.env.AWKN_LLM_BRIDGE_DIR = tmpBridgeDir;
    mkdirSync(tmpBridgeDir, { recursive: true });

    const traeMod = await import('../src/llm/providers/trae.js');
    const hmMod = await import('../src/core/hook-manager.js');
    TraeProvider = traeMod.TraeProvider;
    hookManager = hmMod.hookManager;
  });

  after(() => {
    // 清理注册的 hook
    for (const id of registeredHookIds) {
      hookManager.unload(id);
    }
    // 清理临时目录
    rmSync(tmpBridgeDir, { recursive: true, force: true });
  });

  it('端到端：空 content hook 被跳过，有效 content hook 被采用（M3 进阶-19）', async () => {
    // 注册空 content hook
    const emptyHookId = 'test-empty-content-' + Date.now();
    registeredHookIds.push(emptyHookId);
    hookManager.register({
      id: emptyHookId,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: true,
        llmResponse: { content: '' }, // 空 content — 应被跳过
      }),
      timeout: 5000,
    });

    // 注册有效 content hook（在空 hook 之后）
    const validHookId = 'test-valid-content-' + Date.now();
    registeredHookIds.push(validHookId);
    hookManager.register({
      id: validHookId,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: true,
        llmResponse: {
          content: 'valid LLM response from hook',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        },
      }),
      timeout: 5000,
    });

    const provider = new TraeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'test prompt' }],
    });

    // 应返回有效 content（空 content 被跳过）
    assert.equal(result.content, 'valid LLM response from hook', '应返回有效 content，空 content 被跳过');
    assert.equal(result.finishReason, 'stop', 'finishReason 应为 stop');
    assert.equal(result.provider, 'trae', 'provider 应为 trae');
    assert.equal(result.usage.totalTokens, 30, 'usage 应来自有效 hook');
  });

  it('端到端：纯空白 content hook 也被跳过（fail-closed，M3 进阶-19）', async () => {
    // 清理之前的 hook
    for (const id of registeredHookIds.splice(0)) {
      hookManager.unload(id);
    }

    // 注册纯空白 content hook
    const whitespaceHookId = 'test-whitespace-' + Date.now();
    registeredHookIds.push(whitespaceHookId);
    hookManager.register({
      id: whitespaceHookId,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: true,
        llmResponse: { content: '   \n\t  ' }, // 纯空白 — 应被跳过
      }),
      timeout: 5000,
    });

    // 注册有效 content hook
    const validHookId2 = 'test-valid2-' + Date.now();
    registeredHookIds.push(validHookId2);
    hookManager.register({
      id: validHookId2,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: true,
        llmResponse: { content: 'real response after whitespace hook' },
      }),
      timeout: 5000,
    });

    const provider = new TraeProvider();
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'test' }],
    });

    assert.equal(result.content, 'real response after whitespace hook', '纯空白 content 应被跳过');
  });

  it('端到端：hook 返回 success:false 时不被当作有效响应', async () => {
    for (const id of registeredHookIds.splice(0)) {
      hookManager.unload(id);
    }

    const failHookId = 'test-fail-hook-' + Date.now();
    registeredHookIds.push(failHookId);
    hookManager.register({
      id: failHookId,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: false,
        error: 'hook deliberately failed',
      }),
      timeout: 5000,
    });

    const validHookId3 = 'test-valid3-' + Date.now();
    registeredHookIds.push(validHookId3);
    hookManager.register({
      id: validHookId3,
      point: 'pre_llm_call',
      type: 'function',
      fn: async () => ({
        success: true,
        llmResponse: { content: 'response after failed hook' },
      }),
      timeout: 5000,
    });

    const provider = new TraeProvider();
    const chatPromise = provider.chat({
      messages: [{ role: 'user', content: 'test fail then success' }],
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TEST_TIMEOUT')), 5000),
    );

    const result = await Promise.race([chatPromise, timeoutPromise]);
    assert.equal(result.content, 'response after failed hook', 'success:false hook 应被跳过');
  });
});
