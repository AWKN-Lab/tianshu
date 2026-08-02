import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolPolicy } from '../../src/tools/policy.js';
import type { ToolHandler } from '../../src/tools/types.js';

const writeTool: ToolHandler = {
  name: 'write',
  description: 'write',
  parameters: {},
  source: 'builtin',
  permissionLevel: 'confirm',
  execute: async () => 'ok',
};

const execTool: ToolHandler = {
  name: 'exec',
  description: 'exec',
  parameters: {},
  source: 'builtin',
  permissionLevel: 'confirm',
  execute: async () => 'ok',
};

// beforeEach 清理保证第一个用例前 env 即干净，不依赖外部净化兜底
// （宿主 .env 可能经 loadRuntimeEnv 注入 AWKN_APPROVED_TOOLS 等）。
beforeEach(() => {
  delete process.env.AWKN_APPROVED_TOOLS;
  delete process.env.AWKN_ALLOW_OUTSIDE_WORKSPACE;
  delete process.env.AWKN_ALLOW_SENSITIVE_PATHS;
  delete process.env.AWKN_TOOL_POLICY_MODE;
  delete process.env.AWKN_ALLOW_GITHUB_ACTIONS;
});

afterEach(() => {
  delete process.env.AWKN_APPROVED_TOOLS;
  delete process.env.AWKN_ALLOW_OUTSIDE_WORKSPACE;
  delete process.env.AWKN_ALLOW_SENSITIVE_PATHS;
  delete process.env.AWKN_TOOL_POLICY_MODE;
  delete process.env.AWKN_ALLOW_GITHUB_ACTIONS;
});

describe('ToolPolicy', () => {
  it('requires explicit approval for mutating tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: 'a.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.approvalRequired, true);
  });

  it('allows an approved write inside workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: 'a.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['write'],
    });
    assert.equal(decision.allowed, true);
  });

  it('blocks paths escaping workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: '../outside.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['write'],
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /workspace boundary/);
  });

  it('blocks destructive commands after approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(execTool, { command: 'rm -rf /', cwd: root }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['exec'],
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /command denied/);
  });

  it('blocks GitHub Actions commands after approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(execTool, {
      command: 'gh workflow run release.yml --ref main',
      cwd: root,
    }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['exec'],
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /GitHub Actions denied/);
  });

  it('keeps normal git push available for code hosting', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(execTool, {
      command: 'git push origin main',
      cwd: root,
    }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['exec'],
    });
    assert.equal(decision.allowed, true);
  });
});
