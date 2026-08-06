import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '../src/core/redaction.js';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const derivedRoot = resolve(repoRoot, 'agents/tianhuo/04-记忆与知识/EXPERIENCE/derived');
const fixesRoot = resolve(repoRoot, 'agents/tianhuo/04-记忆与知识/EXPERIENCE/fixes');
const reportRoot = resolve(repoRoot, 'agents/tianhuo/04-记忆与知识/EXPERIENCE/reports');

const draftCandidates = [
  ...Array.from({ length: 9 }, (_, index) =>
    resolve(derivedRoot, `EXP-DRV-20260806-${String(index + 1).padStart(3, '0')}.md`)),
  resolve(fixesRoot, 'EXP-FIX-20260806-001.md'),
];
const retiredCandidates = [resolve(fixesRoot, 'EXP-FIX-20260806-002.md')];
const reports = [
  resolve(reportRoot, '2026-08-06-服务器盘点清理与部署备份策略重构-深度复盘-PDCA报告.md'),
  resolve(reportRoot, '2026-08-06-hindsight孤儿系统识别与清理-深度复盘-PDCA报告.md'),
];
const files = [...draftCandidates, ...retiredCandidates, ...reports];

const forbiddenLiterals = [
  'hindsight2026',
  '8.148.245.29',
  '/srv/time-theater',
  'D:\\awkn-lab\\_backup',
  '5b948a9b71ebf44ced205d9f1d638444259b62f9e0d33f2a6800a35f75ae3d50',
];

describe('Evolution candidate security', () => {
  it('keeps candidate and report files free of credential patterns', () => {
    for (const path of files) {
      const content = readFileSync(path, 'utf-8');
      assert.equal(redactText(content), content, `redaction pattern matched ${path}`);
    }
  });

  it('removes known infrastructure and credential literals from the incident records', () => {
    for (const path of files) {
      const content = readFileSync(path, 'utf-8');
      for (const literal of forbiddenLiterals) {
        assert.equal(content.includes(literal), false, `${literal} remains in ${path}`);
      }
    }
  });

  it('requires structured sanitized DRAFT metadata for ingestible candidates', () => {
    for (const path of draftCandidates) {
      const content = readFileSync(path, 'utf-8');
      assert.match(content, /^---\r?\n/);
      assert.match(content, /schema:\s*awkn-experience\/v1/);
      assert.match(content, /status:\s*DRAFT/);
      assert.match(content, /security_review:\s*sanitized/);
    }
  });

  it('keeps the unsafe worktree-bypass candidate retired', () => {
    const content = readFileSync(retiredCandidates[0]!, 'utf-8');
    assert.match(content, /status:\s*RETIRED/);
    assert.match(content, /ignored_worktree_copy_creates_false_green/);
  });
});
