'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const agentRoot = path.resolve(__dirname, '..');
const engineRoot = path.resolve(agentRoot, '..', '..');
const expectedP0 = [
  'agent.prompt',
  '01-身份与行为/SOUL.md',
  '01-身份与行为/BOUNDARY.md',
  '04-记忆与知识/MEMORY.md',
];
const entrypoints = [
  path.resolve(engineRoot, 'skills', 'tianhuo', 'SKILL.md'),
  path.resolve(engineRoot, 'capabilities', 'project', 'manifest.yaml'),
  path.resolve(engineRoot, 'capabilities', 'project', 'agent-loop-policy.yaml'),
];

const present = expectedP0.filter((item) => fs.existsSync(path.resolve(agentRoot, item)));
const missing = expectedP0.filter((item) => !present.includes(item));
const blockingFindings = [];
const warnings = [];
const staleOrCorruptFiles = [];

for (const entrypoint of entrypoints) {
  if (!fs.existsSync(entrypoint)) {
    // /skills/ is a local skill-library root, deliberately gitignored (not
    // part of the repo); its entrypoints are validated when present, but their
    // absence on a clean checkout must not block CI.
    if (entrypoint.includes(path.sep + 'skills' + path.sep)) {
      warnings.push(`optional external entrypoint not present (local skill library): ${entrypoint}`);
    } else {
      blockingFindings.push(`missing entrypoint: ${entrypoint}`);
    }
  }
}

const configPath = path.resolve(agentRoot, 'config.json');
try {
  const configText = fs.readFileSync(configPath, 'utf8');
  JSON.parse(configText);
  if (configText.includes('.claude\\skills') || configText.includes('.claude/skills')) {
    blockingFindings.push('config.json still contains Claude-specific skill paths');
  }
} catch (error) {
  blockingFindings.push(`invalid config.json: ${error.message}`);
}

const handoffPath = path.resolve(engineRoot, 'skills', 'awkn-程序员天阶功法', 'hooks', 'handoff-schema.json');
const expectedStages = ['discover', 'specify', 'plan', 'build', 'review', 'ship', 'evolve'];
try {
  if (!fs.existsSync(handoffPath)) {
    // Same local-skill-library policy as entrypoints above: schema is
    // validated when the external skill is present, absent on CI checkout.
    warnings.push(`optional external handoff schema not present (local skill library): ${handoffPath}`);
  } else {
    const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
    const stages = handoff.properties?.stage?.enum ?? [];
    if (JSON.stringify(stages) !== JSON.stringify(expectedStages)) {
      blockingFindings.push('handoff stage enum is ambiguous or incomplete');
    }
  }
} catch (error) {
  blockingFindings.push(`invalid handoff schema: ${error.message}`);
}

if (missing.length > 0) blockingFindings.push(`missing P0 files: ${missing.join(', ')}`);

// ===== Capabilities schema 校验 + 路径检查 + content hash =====
const manifestPath = path.resolve(engineRoot, 'capabilities', 'project', 'manifest.yaml');
const capabilitiesRoot = path.resolve(engineRoot, 'capabilities');
const capabilityChecks = [];

if (fs.existsSync(manifestPath)) {
  const manifestText = fs.readFileSync(manifestPath, 'utf8');

  // 解析每个 capability 块：提取 id, card, full_reference
  const capBlocks = manifestText.split(/^\s*-\s+id:\s+/m).slice(1);
  for (const block of capBlocks) {
    const idMatch = block.match(/^([^\s]+)/);
    const cardMatch = block.match(/^\s*card:\s+(\S+)/m);
    const refMatch = block.match(/^\s*full_reference:\s+(\S+)/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    const cardRel = cardMatch ? cardMatch[1] : null;
    const refRel = refMatch ? refMatch[1] : null;

    const check = { id, card: cardRel, fullReference: refRel, cardExists: false, refExists: false, contentHash: null };

    if (cardRel) {
      const cardAbs = path.resolve(capabilitiesRoot, cardRel);
      check.cardExists = fs.existsSync(cardAbs);
      if (!check.cardExists) blockingFindings.push(`capability ${id}: card not found at ${cardRel}`);
    } else {
      blockingFindings.push(`capability ${id}: missing card field`);
    }

    if (refRel) {
      const refAbs = path.resolve(capabilitiesRoot, refRel);
      check.refExists = fs.existsSync(refAbs);
      if (!check.refExists) blockingFindings.push(`capability ${id}: full_reference not found at ${refRel}`);
    } else {
      blockingFindings.push(`capability ${id}: missing full_reference field`);
    }

    // 计算 content hash（card + reference 的 SHA256）
    if (check.cardExists && check.refExists) {
      const cardContent = fs.readFileSync(path.resolve(capabilitiesRoot, cardRel));
      const refContent = fs.readFileSync(path.resolve(capabilitiesRoot, refRel));
      const hasher = crypto.createHash('sha256');
      hasher.update(cardContent);
      hasher.update(refContent);
      check.contentHash = hasher.digest('hex').slice(0, 16);
    }

    capabilityChecks.push(check);
  }

  if (capabilityChecks.length === 0) {
    blockingFindings.push('manifest.yaml: no capabilities parsed');
  }
}

const report = {
  entrypointsChecked: entrypoints,
  p0Status: { expected: expectedP0, missing, present },
  flowConsistency: {
    expected: expectedStages,
    matches: blockingFindings.some((item) => item.includes('handoff')) ? [] : expectedStages,
    mismatches: blockingFindings.filter((item) => item.includes('handoff')),
  },
  safetyConsistency: {
    matches: blockingFindings.some((item) => item.includes('Claude-specific'))
      ? []
      : ['portable skill roots', 'full stage ids'],
    mismatches: blockingFindings.filter((item) => item.includes('Claude-specific')),
  },
  capabilities: {
    checked: capabilityChecks.length,
    results: capabilityChecks,
  },
  staleOrCorruptFiles,
  blockingFindings,
  warnings,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (blockingFindings.length > 0) process.exitCode = 1;
