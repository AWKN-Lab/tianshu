/**
 * Capability Loader 单测
 *
 * 覆盖:
 *  1. 加载真实 capabilities/project/manifest.yaml,tianhuo 卡必须存在
 *  2. content_hash 校验通过(SHA-256, CRLF→LF)
 *  3. alias 解析正确(天火 → tianhuo)
 *  4. hash 不匹配时抛错(strict 模式)
 *  5. manifest 缺失时返回空数组
 *  6. SkillsManager.loadCapabilities 集成
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  loadCapabilityManifest,
  resolveDefaultCapabilitiesRoot,
} from '../src/skills/capability-loader.js';
import { SkillsManager } from '../src/skills/manager.js';

describe('Capability Loader', () => {
  it('loads real manifest.yaml and verifies tianhuo card hash', () => {
    const root = resolveDefaultCapabilitiesRoot();
    assert.ok(existsSync(join(root, 'project', 'manifest.yaml')), 'manifest.yaml should exist');

    const { capabilities, errors } = loadCapabilityManifest(root);
    assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
    assert.ok(capabilities.length >= 10, `expected >=10 capabilities, got ${capabilities.length}`);

    const tianhuo = capabilities.find((c) => c.id === 'tianhuo');
    assert.ok(tianhuo, 'tianhuo capability must be registered');
    assert.equal(tianhuo!.canonicalSkill, 'tianhuo');
    assert.ok(tianhuo!.aliases.includes('天火'), 'aliases should include 天火');
    assert.equal(tianhuo!.visibility, 'public');
    assert.equal(tianhuo!.loopProfile, 'orchestrator');
    assert.ok(tianhuo!.cardBody.length > 0, 'cardBody must not be empty');
    assert.ok(tianhuo!.cardBody.includes('天火'), 'cardBody must mention 天火');
    // content_hash 已在加载时验证,这里再独立算一次确保算法一致
    const expectedHash = createHash('sha256')
      .update(tianhuo!.cardBody.replace(/\r\n/g, '\n'))
      .digest('hex');
    assert.equal(tianhuo!.contentHash, expectedHash);
    assert.match(tianhuo!.contentHash, /^[0-9a-f]{64}$/);
  });

  it('returns empty array when manifest is missing', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'awkn-cap-empty-'));
    const { capabilities, errors } = loadCapabilityManifest(emptyRoot);
    assert.equal(capabilities.length, 0);
    assert.equal(errors.length, 0);
  });

  it('throws on content_hash mismatch in strict mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-cap-bad-'));
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'demo'), { recursive: true });

    const cardContent = '# demo card\n\nbody\n';
    const wrongHash = '0'.repeat(64);
    const manifest = [
      'version: 1',
      'capabilities:',
      '  - id: demo',
      '    version: "1.0.0"',
      '    canonical_skill: demo',
      '    visibility: public',
      '    card: project/demo/card.md',
      '    loop_profile: default',
      `    content_hash: ${wrongHash}`,
      '',
    ].join('\n');
    writeFileSync(join(projectDir, 'demo', 'card.md'), cardContent);
    writeFileSync(join(projectDir, 'manifest.yaml'), manifest);

    assert.throws(
      () => loadCapabilityManifest(root, { strictHash: true }),
      /content_hash mismatch for demo/,
    );
  });

  it('records error instead of throwing in non-strict mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-cap-nonstrict-'));
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'demo'), { recursive: true });

    const cardContent = '# demo\n';
    const wrongHash = 'f'.repeat(64);
    const manifest = [
      'version: 1',
      'capabilities:',
      '  - id: demo',
      '    canonical_skill: demo',
      '    card: project/demo/card.md',
      `    content_hash: ${wrongHash}`,
      '',
    ].join('\n');
    writeFileSync(join(projectDir, 'demo', 'card.md'), cardContent);
    writeFileSync(join(projectDir, 'manifest.yaml'), manifest);

    const { capabilities, errors } = loadCapabilityManifest(root, { strictHash: false });
    assert.equal(capabilities.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /content_hash mismatch/);
  });

  it('parses aliases list correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-cap-alias-'));
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'multi'), { recursive: true });

    const cardContent = '# multi\n';
    const realHash = createHash('sha256').update(cardContent).digest('hex');
    const manifest = [
      'version: 1',
      'capabilities:',
      '  - id: multi',
      '    canonical_skill: multi-skill',
      '    aliases:',
      '      - 别名1',
      '      - alias2',
      '    visibility: public',
      '    card: project/multi/card.md',
      `    content_hash: ${realHash}`,
      '',
    ].join('\n');
    writeFileSync(join(projectDir, 'multi', 'card.md'), cardContent);
    writeFileSync(join(projectDir, 'manifest.yaml'), manifest);

    const { capabilities } = loadCapabilityManifest(root);
    assert.equal(capabilities.length, 1);
    assert.deepEqual(capabilities[0]!.aliases, ['别名1', 'alias2']);
  });

  it('SkillsManager.loadCapabilities integrates with alias lookup', () => {
    const root = resolveDefaultCapabilitiesRoot();
    const sm = new SkillsManager(join(root, 'does-not-exist'));
    // skillsRoot 不存在不影响 capability 加载
    sm.loadCapabilities(root);

    const byId = sm.getCapability('tianhuo');
    assert.ok(byId, 'by id should find tianhuo');
    const byAlias = sm.getCapability('天火');
    assert.ok(byAlias, 'by alias 天火 should find tianhuo');
    assert.equal(byId, byAlias);

    const card = sm.getCapabilityCard('tianhuo');
    assert.ok(card && card.length > 0);
    const ref = sm.getCapabilityReference('tianhuo');
    assert.ok(ref && ref.length > 0, 'tianhuo must have reference.md');

    const caps = sm.getCapabilities();
    assert.ok(caps.length >= 10);
    assert.equal(sm.getCapabilitiesRoot(), root);
  });

  it('all real capability cards pass hash verification', () => {
    // 兜底:与 capability-manifest.test.ts 形成双重保险
    const root = resolveDefaultCapabilitiesRoot();
    const { capabilities, errors } = loadCapabilityManifest(root);
    assert.equal(errors.length, 0);
    for (const cap of capabilities) {
      const recomputed = createHash('sha256')
        .update(cap.cardBody.replace(/\r\n/g, '\n'))
        .digest('hex');
      assert.equal(recomputed, cap.contentHash, `hash mismatch for ${cap.id}`);
    }
  });
});
