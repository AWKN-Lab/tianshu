/**
 * Skill DAG Validation Contract Tests (Phase 6 / C04 / WP-AOS-07)
 *
 * Covers:
 * - validateSkillDag: missing dependencies
 * - validateSkillDag: self-dependencies
 * - validateSkillDag: real cycles (A->B->C->A, partial cycles)
 * - validateSkillDag: valid DAG passes
 * - DagValidationResult structure verification
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SkillExecutionNode } from '../../src/contracts/skill.js';
import { validateSkillDag } from '../../src/skills/compiler.js';

function makeNode(
  nodeId: string,
  skillId: string,
  dependsOn: string[] = [],
): SkillExecutionNode {
  return {
    nodeId,
    skillId,
    step: 'step',
    dependsOn,
    produces: [`${nodeId}_output`],
    consumes: dependsOn.map((d) => `${d}_output`),
  };
}
describe('validateSkillDag - Missing Dependencies', () => {
  it('detects single missing dependency', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['X']),
      makeNode('B', 'skill-b', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.equal(result.missingDependencies.length, 1);
    assert.equal(result.missingDependencies[0]!.nodeId, 'A');
    assert.equal(result.missingDependencies[0]!.missingDep, 'X');
  });

  it('detects multiple missing dependencies across nodes', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['X', 'Y']),
      makeNode('B', 'skill-b', ['A', 'Z']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.equal(result.missingDependencies.length, 3);
    const missingDeps = result.missingDependencies.map((m) => m.missingDep).sort();
    assert.deepEqual(missingDeps, ['X', 'Y', 'Z']);
  });

  it('reports empty missingDependencies when all deps exist', () => {
    const nodes = [
      makeNode('A', 'skill-a'),
      makeNode('B', 'skill-b', ['A']),
      makeNode('C', 'skill-c', ['A', 'B']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.missingDependencies.length, 0);
  });
});
describe('validateSkillDag - Self Dependencies', () => {
  it('detects single self-dependency', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.equal(result.selfDependencies.length, 1);
    assert.equal(result.selfDependencies[0], 'A');
  });

  it('detects multiple self-dependencies', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['A']),
      makeNode('B', 'skill-b', ['B']),
      makeNode('C', 'skill-c', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.equal(result.selfDependencies.length, 2);
    assert.ok(result.selfDependencies.includes('A'));
    assert.ok(result.selfDependencies.includes('B'));
  });

  it('reports empty selfDependencies when no self-deps', () => {
    const nodes = [
      makeNode('A', 'skill-a'),
      makeNode('B', 'skill-b', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.selfDependencies.length, 0);
  });
});
describe('validateSkillDag - Real Cycles', () => {
  it('detects simple cycle A->B->C->A', () => {
    // A depends on B, B depends on C, C depends on A
    const nodes = [
      makeNode('A', 'skill-a', ['B']),
      makeNode('B', 'skill-b', ['C']),
      makeNode('C', 'skill-c', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.cycles.length >= 1, `expected at least 1 cycle, got ${result.cycles.length}`);
    const cycle = result.cycles[0]!;
    assert.ok(cycle.length >= 3, `cycle should have at least 3 nodes, got ${cycle.length}`);
    // Cycle should start and end with the same node
    assert.equal(cycle[0], cycle[cycle.length - 1]);
    // All three nodes should be in the cycle
    const cycleSet = new Set(cycle);
    assert.ok(cycleSet.has('A'));
    assert.ok(cycleSet.has('B'));
    assert.ok(cycleSet.has('C'));
  });

  it('detects partial cycle A->B->C->D->B', () => {
    // A depends on B, B depends on C, C depends on D, D depends on B
    // Cycle: B->C->D->B
    const nodes = [
      makeNode('A', 'skill-a', ['B']),
      makeNode('B', 'skill-b', ['C']),
      makeNode('C', 'skill-c', ['D']),
      makeNode('D', 'skill-d', ['B']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.cycles.length >= 1, `expected at least 1 cycle, got ${result.cycles.length}`);
    const cycle = result.cycles[0]!;
    // Cycle should contain B, C, D (not A, which is outside the cycle)
    const cycleSet = new Set(cycle);
    assert.ok(cycleSet.has('B'), 'cycle should contain B');
    assert.ok(cycleSet.has('C'), 'cycle should contain C');
    assert.ok(cycleSet.has('D'), 'cycle should contain D');
    // Cycle should start and end with the same node
    assert.equal(cycle[0], cycle[cycle.length - 1]);
  });

  it('detects two-node cycle A->B->A', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['B']),
      makeNode('B', 'skill-b', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.cycles.length >= 1);
    const cycle = result.cycles[0]!;
    assert.equal(cycle[0], cycle[cycle.length - 1]);
    assert.ok(new Set(cycle).has('A'));
    assert.ok(new Set(cycle).has('B'));
  });

  it('detects self-cycle as both self-dependency and cycle', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, false);
    assert.equal(result.selfDependencies.length, 1);
  });
});
describe('validateSkillDag - Valid DAG', () => {
  it('accepts simple linear DAG A->B->C', () => {
    const nodes = [
      makeNode('A', 'skill-a'),
      makeNode('B', 'skill-b', ['A']),
      makeNode('C', 'skill-c', ['B']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, true);
    assert.equal(result.missingDependencies.length, 0);
    assert.equal(result.selfDependencies.length, 0);
    assert.equal(result.cycles.length, 0);
  });

  it('accepts diamond DAG A->{B,C}->D', () => {
    const nodes = [
      makeNode('A', 'skill-a'),
      makeNode('B', 'skill-b', ['A']),
      makeNode('C', 'skill-c', ['A']),
      makeNode('D', 'skill-d', ['B', 'C']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, true);
    assert.equal(result.cycles.length, 0);
  });

  it('accepts single node (no deps)', () => {
    const nodes = [makeNode('A', 'skill-a')];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, true);
  });

  it('accepts empty graph', () => {
    const result = validateSkillDag([]);
    assert.equal(result.valid, true);
    assert.equal(result.missingDependencies.length, 0);
    assert.equal(result.selfDependencies.length, 0);
    assert.equal(result.cycles.length, 0);
  });

  it('accepts forest of independent chains', () => {
    const nodes = [
      makeNode('A1', 'skill-a'),
      makeNode('A2', 'skill-a', ['A1']),
      makeNode('B1', 'skill-b'),
      makeNode('B2', 'skill-b', ['B1']),
      makeNode('B3', 'skill-b', ['B2']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(result.valid, true);
  });
});

describe('validateSkillDag - DagValidationResult Structure', () => {
  it('returns well-formed result object', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['X']),
      makeNode('A', 'skill-a', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.equal(typeof result.valid, 'boolean');
    assert.ok(Array.isArray(result.missingDependencies));
    assert.ok(Array.isArray(result.selfDependencies));
    assert.ok(Array.isArray(result.cycles));
  });

  it('missingDependencies entries have nodeId and missingDep fields', () => {
    const nodes = [makeNode('A', 'skill-a', ['X'])];
    const result = validateSkillDag(nodes);
    assert.equal(result.missingDependencies.length, 1);
    const entry = result.missingDependencies[0]!;
    assert.equal(typeof entry.nodeId, 'string');
    assert.equal(typeof entry.missingDep, 'string');
  });

  it('cycles entries are arrays of strings', () => {
    const nodes = [
      makeNode('A', 'skill-a', ['B']),
      makeNode('B', 'skill-b', ['A']),
    ];
    const result = validateSkillDag(nodes);
    assert.ok(result.cycles.length >= 1);
    const cycle = result.cycles[0]!;
    assert.ok(Array.isArray(cycle));
    for (const node of cycle) {
      assert.equal(typeof node, 'string');
    }
  });
});