import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(__dirname, '..', '..', '.trae', 'hooks', 'tianshu-hook.mjs');

function invokePreTool(payload: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [hookPath, 'pre-tool'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AWKN_ALLOW_GITHUB_ACTIONS: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('TRAE hook denies GitHub Actions commands', () => {
  const output = invokePreTool({
    tool_name: 'RunCommand',
    tool_input: { command: 'gh workflow run deploy-production.yml --ref main' },
  });
  assert.equal(output.block, true);
  assert.equal(output.permissionDecision, 'deny');
  assert.match(String(output.blockReason), /GitHub Actions/);
});

test('TRAE hook keeps git push available for code hosting', () => {
  const output = invokePreTool({
    tool_name: 'RunCommand',
    tool_input: { command: 'git push origin main' },
  });
  assert.equal(output.block, undefined);
});

test('TRAE hook denies edits that recreate workflow execution', () => {
  const output = invokePreTool({
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\repo\\.github\\workflows\\ci.yml' },
  });
  assert.equal(output.block, true);
  assert.match(String(output.blockReason), /\.github/i);
});
