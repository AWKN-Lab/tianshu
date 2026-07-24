import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsManager, resolveDefaultSkillsRoot } from '../../src/skills/manager.js';

describe('SkillsManager', () => {
  it('loads nested external skills, skips disabled records and matches triggers', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-skills-'));
    const activeDir = join(root, 'active');
    const disabledDir = join(root, 'disabled');
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(disabledDir, { recursive: true });
    writeFileSync(join(activeDir, 'SKILL.md'), `---\nname: repo-audit\nversion: 1.2.0\ndescription: audit repositories\ntriggers: [audit, repository]\n---\nRun the audit.\n`);
    writeFileSync(join(disabledDir, 'SKILL.md'), `---\nname: disabled\nenabled: false\n---\nDo not load.\n`);

    const manager = new SkillsManager(root);
    const loaded = manager.loadAll();
    assert.deepEqual(loaded.map((skill) => skill.name), ['repo-audit']);
    assert.equal(manager.getSkillBody('repo-audit')?.trim(), 'Run the audit.');
    assert.equal(manager.matchTriggers('please audit this repository').length, 1);
  });

  it('resolves the repository skills skeleton independently of process.cwd()', () => {
    const resolved = resolveDefaultSkillsRoot().replace(/\\/g, '/');
    assert.match(resolved, /\/skills$/);
  });
});
