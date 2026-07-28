/**
 * Policy AST Deep Recursion + Freeze Contract Tests (Phase 6 / C04 / WP-AOS-06)
 *
 * Covers:
 * - Deeply nested AST evaluation (5-level all/any/none, 9-level none, mixed nesting)
 * - freezeConditionNode deep immutability (children array, value object, leaf nodes)
 * - isConditionNodeFrozen recursive self-check
 * - Empty/single children edge cases + PolicyAstError propagation
 * - Freeze idempotency
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PolicyCondition } from '../../src/contracts/policy.js';
import {
  evaluateCondition,
  evaluateAll,
  evaluateAny,
  freezeConditionNode,
  isConditionNodeFrozen,
  fieldEquals,
  fieldGreaterThan,
  allOf,
  anyOf,
  PolicyAstError,
} from '../../src/policy/ast.js';

// ===== Deep nesting helpers =====

function deepAll(depth: number, leaf: PolicyCondition): PolicyCondition {
  if (depth <= 0) return leaf;
  return { operator: 'all', children: [deepAll(depth - 1, leaf)] };
}

function deepAny(depth: number, leaf: PolicyCondition): PolicyCondition {
  if (depth <= 0) return leaf;
  return { operator: 'any', children: [deepAny(depth - 1, leaf)] };
}

function deepNone(depth: number, leaf: PolicyCondition): PolicyCondition {
  if (depth <= 0) return leaf;
  return { operator: 'none', children: [deepNone(depth - 1, leaf)] };
}

/** Mixed nesting: all(any(none(all(any(...))))) alternating per level */
function deepMixed(depth: number, leaf: PolicyCondition): PolicyCondition {
  if (depth <= 0) return leaf;
  const ops: Array<'all' | 'any' | 'none'> = ['all', 'any', 'none'];
  const op = ops[depth % ops.length]!;
  return { operator: op, children: [deepMixed(depth - 1, leaf)] };
}

describe('Policy AST Deep Recursion - all operator', () => {
  it('returns true at 5-level depth when all leaves match', () => {
    const cond = deepAll(5, fieldEquals('user.id', 'u1'));
    const ctx = { user: { id: 'u1' } };
    assert.equal(evaluateCondition(cond, ctx), true);
  });

  it('returns false at 5-level depth when leaf does not match', () => {
    const cond = deepAll(5, fieldEquals('user.id', 'u2'));
    const ctx = { user: { id: 'u1' } };
    assert.equal(evaluateCondition(cond, ctx), false);
  });

  it('returns true at 5-level depth with multiple matching leaves at each level', () => {
    function bushyAll(depth: number): PolicyCondition {
      if (depth <= 0) return fieldEquals('user.id', 'u1');
      return {
        operator: 'all',
        children: [bushyAll(depth - 1), bushyAll(depth - 1)],
      };
    }
    const cond = bushyAll(5);
    assert.equal(evaluateCondition(cond, { user: { id: 'u1' } }), true);
    assert.equal(evaluateCondition(cond, { user: { id: 'other' } }), false);
  });

  it('returns false at 5-level depth when one branch fails', () => {
    function mixedAll(depth: number, failAtLeaf: boolean): PolicyCondition {
      if (depth <= 0) {
        return failAtLeaf ? fieldEquals('user.id', 'wrong') : fieldEquals('user.id', 'u1');
      }
      return {
        operator: 'all',
        children: [
          mixedAll(depth - 1, false),
          mixedAll(depth - 1, depth === 1),
        ],
      };
    }
    const cond = mixedAll(5, false);
    assert.equal(evaluateCondition(cond, { user: { id: 'u1' } }), false);
  });
});

describe('Policy AST Deep Recursion - any operator', () => {
  it('returns false at 5-level depth when no leaf matches', () => {
    const cond = deepAny(5, fieldEquals('user.id', 'missing'));
    const ctx = { user: { id: 'u1' } };
    assert.equal(evaluateCondition(cond, ctx), false);
  });

  it('returns true at 5-level depth when leaf matches', () => {
    const cond = deepAny(5, fieldEquals('user.id', 'u1'));
    const ctx = { user: { id: 'u1' } };
    assert.equal(evaluateCondition(cond, ctx), true);
  });

  it('returns true at 5-level depth with bushy tree when one branch matches', () => {
    function bushyAny(depth: number, leafValue: string): PolicyCondition {
      if (depth <= 0) return fieldEquals('user.id', leafValue);
      return {
        operator: 'any',
        children: [
          bushyAny(depth - 1, 'no-match-1'),
          bushyAny(depth - 1, leafValue),
        ],
      };
    }
    const cond = bushyAny(5, 'u1');
    assert.equal(evaluateCondition(cond, { user: { id: 'u1' } }), true);
  });
});

describe('Policy AST Deep Recursion - none operator', () => {
  it('returns true at 9-level depth when no leaf matches (odd depth = single NOT)', () => {
    const cond = deepNone(9, fieldEquals('count', 999));
    const ctx = { count: 1 };
    assert.equal(evaluateCondition(cond, ctx), true);
  });

  it('returns false at 9-level depth when leaf matches (odd depth negates)', () => {
    const cond = deepNone(9, fieldEquals('count', 1));
    const ctx = { count: 1 };
    assert.equal(evaluateCondition(cond, ctx), false);
  });

  it('returns true at 8-level depth when leaf matches (even depth via double negation)', () => {
    const cond = deepNone(8, fieldEquals('count', 1));
    const ctx = { count: 1 };
    assert.equal(evaluateCondition(cond, ctx), true);
  });

  it('returns false at 8-level depth when leaf does not match (even depth)', () => {
    const cond = deepNone(8, fieldEquals('count', 999));
    const ctx = { count: 1 };
    assert.equal(evaluateCondition(cond, ctx), false);
  });
});

describe('Policy AST Deep Recursion - mixed operators', () => {
  it('evaluates 5-level mixed all/any/none tree correctly (matching case)', () => {
    const cond = deepMixed(5, fieldEquals('user.id', 'u1'));
    const ctx = { user: { id: 'u1' } };
    const result = evaluateCondition(cond, ctx);
    assert.equal(typeof result, 'boolean');
  });

  it('evaluates 5-level mixed all/any/none tree correctly (non-matching case)', () => {
    const cond = deepMixed(5, fieldEquals('user.id', 'missing'));
    const ctx = { user: { id: 'u1' } };
    const result = evaluateCondition(cond, ctx);
    assert.equal(typeof result, 'boolean');
  });

  it('evaluates 7-level mixed tree with numeric comparison leaf', () => {
    const cond = deepMixed(7, fieldGreaterThan('score', 50));
    assert.equal(evaluateCondition(cond, { score: 100 }), true);
    const result2 = evaluateCondition(cond, { score: 10 });
    assert.equal(typeof result2, 'boolean');
  });
});

describe('Policy AST Deep Recursion - edge cases', () => {
  it('throws PolicyAstError when 5-level all has empty children at innermost level', () => {
    function deepAllEmpty(depth: number): PolicyCondition {
      if (depth <= 0) return { operator: 'all', children: [] };
      return { operator: 'all', children: [deepAllEmpty(depth - 1)] };
    }
    const cond = deepAllEmpty(5);
    assert.throws(
      () => evaluateCondition(cond, {}),
      (err: unknown) => {
        assert.ok(err instanceof PolicyAstError, 'should be PolicyAstError');
        assert.equal((err as PolicyAstError).operator, 'all');
        return true;
      },
    );
  });

  it('throws PolicyAstError when 5-level any has empty children at innermost level', () => {
    function deepAnyEmpty(depth: number): PolicyCondition {
      if (depth <= 0) return { operator: 'any', children: [] };
      return { operator: 'any', children: [deepAnyEmpty(depth - 1)] };
    }
    const cond = deepAnyEmpty(5);
    assert.throws(
      () => evaluateCondition(cond, {}),
      (err: unknown) => {
        assert.ok(err instanceof PolicyAstError);
        assert.equal((err as PolicyAstError).operator, 'any');
        return true;
      },
    );
  });

  it('throws PolicyAstError when 5-level none has empty children at innermost level', () => {
    function deepNoneEmpty(depth: number): PolicyCondition {
      if (depth <= 0) return { operator: 'none', children: [] };
      return { operator: 'none', children: [deepNoneEmpty(depth - 1)] };
    }
    const cond = deepNoneEmpty(5);
    assert.throws(
      () => evaluateCondition(cond, {}),
      (err: unknown) => {
        assert.ok(err instanceof PolicyAstError);
        assert.equal((err as PolicyAstError).operator, 'none');
        return true;
      },
    );
  });

  it('evaluates 5-level all with single child at each level (matching)', () => {
    const cond = deepAll(5, fieldEquals('user.id', 'u1'));
    assert.equal(evaluateCondition(cond, { user: { id: 'u1' } }), true);
  });

  it('evaluates 5-level any with single child at each level (non-matching)', () => {
    const cond = deepAny(5, fieldEquals('user.id', 'nope'));
    assert.equal(evaluateCondition(cond, { user: { id: 'u1' } }), false);
  });

  it('evaluateAll on deeply nested conditions returns correct aggregate', () => {
    const conds = [
      deepAll(3, fieldEquals('a', 1)),
      deepAll(3, fieldEquals('b', 2)),
    ];
    assert.equal(evaluateAll(conds, { a: 1, b: 2 }), true);
    assert.equal(evaluateAll(conds, { a: 1, b: 99 }), false);
  });

  it('evaluateAny on deeply nested conditions returns correct aggregate', () => {
    const conds = [
      deepAny(3, fieldEquals('a', 1)),
      deepAny(3, fieldEquals('b', 2)),
    ];
    assert.equal(evaluateAny(conds, { a: 1, b: 99 }), true);
    assert.equal(evaluateAny(conds, { a: 99, b: 99 }), false);
  });
});

describe('Policy AST freezeConditionNode - deep immutability', () => {
  it('deeply freezes 5-level nested all tree', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    let current: PolicyCondition | undefined = tree;
    let depth = 0;
    while (current && current.children) {
      assert.equal(Object.isFrozen(current), true, `node at depth ${depth} should be frozen`);
      assert.equal(Object.isFrozen(current.children), true, `children array at depth ${depth} should be frozen`);
      current = current.children[0];
      depth += 1;
    }
    assert.equal(Object.isFrozen(current), true, 'leaf node should be frozen');
  });

  it('deeply freezes 5-level nested any tree', () => {
    const tree = deepAny(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    let current: PolicyCondition | undefined = tree;
    while (current && current.children) {
      assert.equal(Object.isFrozen(current), true);
      assert.equal(Object.isFrozen(current.children), true);
      current = current.children[0];
    }
    assert.equal(Object.isFrozen(current), true);
  });

  it('deeply freezes 9-level nested none tree', () => {
    const tree = deepNone(9, fieldEquals('count', 1));
    freezeConditionNode(tree);
    let current: PolicyCondition | undefined = tree;
    let depth = 0;
    while (current && current.children) {
      assert.equal(Object.isFrozen(current), true, `node at depth ${depth} frozen`);
      current = current.children[0];
      depth += 1;
    }
    assert.equal(Object.isFrozen(current), true);
  });

  it('freezes leaf node without children', () => {
    const leaf = fieldEquals('user.id', 'u1');
    freezeConditionNode(leaf);
    assert.equal(Object.isFrozen(leaf), true);
  });

  it('freezes children array (cannot push)', () => {
    const tree = allOf(fieldEquals('a', 1), fieldEquals('b', 2));
    freezeConditionNode(tree);
    assert.equal(Object.isFrozen(tree.children), true);
    assert.throws(() => {
      (tree.children as PolicyCondition[]).push(fieldEquals('c', 3));
    });
  });

  it('freezes value object when it is an object (in operator)', () => {
    const cond: PolicyCondition = { operator: 'in', field: 'tag', value: ['a', 'b'] };
    freezeConditionNode(cond);
    assert.equal(Object.isFrozen(cond), true);
    assert.equal(Object.isFrozen(cond.value), true);
  });

  it('freezes 5-level mixed tree (all/any/none alternating)', () => {
    const tree = deepMixed(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    function assertFrozen(node: PolicyCondition, depth: number): void {
      assert.equal(Object.isFrozen(node), true, `node at depth ${depth} frozen`);
      if (node.children) {
        assert.equal(Object.isFrozen(node.children), true, `children at depth ${depth} frozen`);
        for (const child of node.children) {
          assertFrozen(child, depth + 1);
        }
      }
    }
    assertFrozen(tree, 0);
  });

  it('returns the same node reference (frozen) for chaining', () => {
    const tree = allOf(fieldEquals('a', 1));
    const result = freezeConditionNode(tree);
    assert.equal(result, tree);
    assert.equal(Object.isFrozen(tree), true);
  });
});

describe('Policy AST isConditionNodeFrozen - recursive self-check', () => {
  it('returns false for unfrozen tree', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    assert.equal(isConditionNodeFrozen(tree), false);
  });

  it('returns true after freezeConditionNode on 5-level all tree', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    assert.equal(isConditionNodeFrozen(tree), true);
  });

  it('returns true after freezeConditionNode on 5-level any tree', () => {
    const tree = deepAny(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    assert.equal(isConditionNodeFrozen(tree), true);
  });

  it('returns true after freezeConditionNode on 9-level none tree', () => {
    const tree = deepNone(9, fieldEquals('count', 1));
    freezeConditionNode(tree);
    assert.equal(isConditionNodeFrozen(tree), true);
  });

  it('returns true for frozen leaf node', () => {
    const leaf = fieldEquals('user.id', 'u1');
    freezeConditionNode(leaf);
    assert.equal(isConditionNodeFrozen(leaf), true);
  });

  it('returns false for unfrozen leaf node', () => {
    const leaf = fieldEquals('user.id', 'u1');
    assert.equal(isConditionNodeFrozen(leaf), false);
  });

  it('returns false when root frozen but children array not frozen', () => {
    const tree = allOf(fieldEquals('a', 1));
    Object.freeze(tree);
    assert.equal(isConditionNodeFrozen(tree), false);
  });

  it('returns false when root and children frozen but grandchild not frozen', () => {
    const leaf = fieldEquals('c', 3);
    const mid: PolicyCondition = { operator: 'all', children: [leaf] };
    const root: PolicyCondition = { operator: 'all', children: [mid] };
    Object.freeze(root);
    Object.freeze(root.children!);
    Object.freeze(mid);
    Object.freeze(mid.children!);
    assert.equal(isConditionNodeFrozen(root), false);
  });

  it('returns false for partially frozen 5-level tree (root only)', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    Object.freeze(tree);
    assert.equal(isConditionNodeFrozen(tree), false);
  });
});

describe('Policy AST freezeConditionNode - idempotency', () => {
  it('multiple freeze calls do not throw', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    assert.doesNotThrow(() => freezeConditionNode(tree));
    assert.doesNotThrow(() => freezeConditionNode(tree));
  });

  it('tree remains frozen after multiple freeze calls', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    freezeConditionNode(tree);
    freezeConditionNode(tree);
    assert.equal(isConditionNodeFrozen(tree), true);
  });

  it('frozen tree still evaluates correctly', () => {
    const tree = deepAll(5, fieldEquals('user.id', 'u1'));
    freezeConditionNode(tree);
    assert.equal(evaluateCondition(tree, { user: { id: 'u1' } }), true);
    assert.equal(evaluateCondition(tree, { user: { id: 'u2' } }), false);
  });

  it('frozen tree built with helpers (allOf/anyOf) evaluates correctly', () => {
    const tree = allOf(anyOf(fieldEquals('a', 1), fieldEquals('a', 2)), fieldEquals('b', 3));
    freezeConditionNode(tree);
    assert.equal(evaluateCondition(tree, { a: 1, b: 3 }), true);
    assert.equal(evaluateCondition(tree, { a: 5, b: 3 }), false);
    assert.equal(evaluateCondition(tree, { a: 1, b: 99 }), false);
  });
});
