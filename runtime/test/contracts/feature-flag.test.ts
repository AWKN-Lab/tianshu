import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  AGENT_OS_FLAGS,
  FEATURE_FLAG_DEPENDENCIES,
  FEATURE_FLAG_SNAPSHOT_SCHEMA,
  FeatureFlagError,
  FeatureFlagSnapshotSchema,
  type AgentOsFlag,
  type FeatureFlagValue,
} from '../../src/contracts/feature-flag.js';
import { FeatureFlagRegistry } from '../../src/feature-flag/feature-flag-registry.js';

describe('FeatureFlagRegistry', () => {
  let registry: FeatureFlagRegistry;

  beforeEach(() => {
    registry = new FeatureFlagRegistry();
  });

  describe('defaults', () => {
    it('initializes all flags to "0" by default', () => {
      for (const flag of AGENT_OS_FLAGS) {
        assert.equal(registry.getValue(flag), '0');
        assert.equal(registry.getSource(flag), 'code-default');
      }
    });

    it('accepts custom defaults in constructor', () => {
      const custom = new FeatureFlagRegistry({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
      });
      assert.equal(custom.getValue('AWKN_INPUT_GATEWAY_V1'), 'shadow');
      assert.equal(custom.getSource('AWKN_INPUT_GATEWAY_V1'), 'code-default');
    });
  });

  describe('applyEnv', () => {
    it('loads values from environment variables', () => {
      registry.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });
      assert.equal(registry.getValue('AWKN_INPUT_GATEWAY_V1'), 'shadow');
      assert.equal(registry.getSource('AWKN_INPUT_GATEWAY_V1'), 'env');
    });

    it('skips undefined env entries', () => {
      registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: undefined });
      assert.equal(registry.getValue('AWKN_INPUT_GATEWAY_V1'), '0');
      assert.equal(registry.getSource('AWKN_INPUT_GATEWAY_V1'), 'code-default');
    });

    it('rejects unknown flag value', () => {
      assert.throws(
        () => registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'invalid' }),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_INVALID_VALUE',
      );
    });
  });

  describe('applyConfig', () => {
    it('overrides env values with deploy config', () => {
      registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'shadow' });
      registry.applyConfig({ AWKN_INPUT_GATEWAY_V1: 'enforce' });
      assert.equal(registry.getValue('AWKN_INPUT_GATEWAY_V1'), 'enforce');
      assert.equal(registry.getSource('AWKN_INPUT_GATEWAY_V1'), 'deploy-config');
    });

    it('does not override execution-override', () => {
      registry.applyOverride('AWKN_INPUT_GATEWAY_V1', 'shadow');
      registry.applyConfig({ AWKN_INPUT_GATEWAY_V1: 'enforce' });
      assert.equal(registry.getValue('AWKN_INPUT_GATEWAY_V1'), 'shadow');
      assert.equal(registry.getSource('AWKN_INPUT_GATEWAY_V1'), 'execution-override');
    });
  });

  describe('applyOverride', () => {
    it('overrides all other sources', () => {
      registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'shadow' });
      registry.applyConfig({ AWKN_INPUT_GATEWAY_V1: 'enforce' });
      registry.applyOverride('AWKN_INPUT_GATEWAY_V1', '0');
      assert.equal(registry.getValue('AWKN_INPUT_GATEWAY_V1'), '0');
      assert.equal(registry.getSource('AWKN_INPUT_GATEWAY_V1'), 'execution-override');
    });

    it('rejects unknown flag name', () => {
      assert.throws(
        () => registry.applyOverride('AWKN_UNKNOWN_FLAG' as AgentOsFlag, 'shadow'),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_UNKNOWN',
      );
    });

    it('rejects invalid value', () => {
      assert.throws(
        () => registry.applyOverride('AWKN_INPUT_GATEWAY_V1', 'invalid' as FeatureFlagValue),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_INVALID_VALUE',
      );
    });
  });

  describe('dependency validation', () => {
    it('allows all flags at "0" (no dependencies triggered)', () => {
      const snapshot = registry.freeze();
      assert.equal(snapshot.schema, FEATURE_FLAG_SNAPSHOT_SCHEMA);
    });

    it('rejects Intent=shadow when Input="0"', () => {
      registry.applyEnv({ AWKN_INTENT_ROUTER_V1: 'shadow' });
      assert.throws(
        () => registry.freeze(),
        (err: FeatureFlagError) =>
          err.code === 'AOS_FLAG_DEPENDENCY_INVALID' &&
          /AWKN_INTENT_ROUTER_V1=shadow requires AWKN_INPUT_GATEWAY_V1>=shadow/.test(err.message),
      );
    });

    it('rejects Context=shadow when Intent="0"', () => {
      registry.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });
      assert.throws(
        () => registry.freeze(),
        (err: FeatureFlagError) =>
          err.code === 'AOS_FLAG_DEPENDENCY_INVALID' &&
          /AWKN_CONTEXT_PLANNER_V1=shadow requires AWKN_INTENT_ROUTER_V1>=shadow/.test(err.message),
      );
    });

    it('allows Intent=shadow when Input=shadow', () => {
      registry.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
      });
      const snapshot = registry.freeze();
      assert.equal(snapshot.flags.AWKN_INPUT_GATEWAY_V1, 'shadow');
      assert.equal(snapshot.flags.AWKN_INTENT_ROUTER_V1, 'shadow');
    });

    it('allows Intent=enforce when Input=enforce', () => {
      registry.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'enforce',
        AWKN_INTENT_ROUTER_V1: 'enforce',
        AWKN_CONTEXT_PLANNER_V1: 'enforce',
      });
      const snapshot = registry.freeze();
      assert.equal(snapshot.flags.AWKN_CONTEXT_PLANNER_V1, 'enforce');
    });

    it('allows Context=shadow when Intent=shadow (R2 shadow baseline)', () => {
      registry.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });
      const snapshot = registry.freeze();
      assert.equal(snapshot.flags.AWKN_CONTEXT_PLANNER_V1, 'shadow');
    });
  });

  describe('freeze', () => {
    it('returns an immutable FeatureFlagSnapshot', () => {
      const snapshot = registry.freeze();
      assert.equal(snapshot.schema, FEATURE_FLAG_SNAPSHOT_SCHEMA);
      assert.match(snapshot.snapshotId, /^fsnap_[0-9a-f]{32}$/);
      assert.equal(typeof snapshot.sourceHash, 'string');
      assert.equal(snapshot.sourceHash.length, 64);
      assert.equal(typeof snapshot.frozenAt, 'string');
      // Object.freeze makes the object shallowly immutable
      assert.throws(() => {
        (snapshot.flags as Record<AgentOsFlag, FeatureFlagValue>).AWKN_INPUT_GATEWAY_V1 = 'enforce';
      });
    });

    it('marks the registry as frozen', () => {
      assert.equal(registry.isFrozen(), false);
      registry.freeze();
      assert.equal(registry.isFrozen(), true);
    });

    it('rejects modifications after freeze', () => {
      registry.freeze();
      assert.throws(
        () => registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'shadow' }),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_SNAPSHOT_FROZEN',
      );
      assert.throws(
        () => registry.applyConfig({ AWKN_INPUT_GATEWAY_V1: 'shadow' }),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_SNAPSHOT_FROZEN',
      );
      assert.throws(
        () => registry.applyOverride('AWKN_INPUT_GATEWAY_V1', 'shadow'),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_SNAPSHOT_FROZEN',
      );
    });

    it('produces stable sourceHash for identical configuration', () => {
      const r1 = new FeatureFlagRegistry();
      r1.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });
      const s1 = r1.freeze();

      const r2 = new FeatureFlagRegistry();
      r2.applyEnv({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });
      const s2 = r2.freeze();

      assert.equal(s1.sourceHash, s2.sourceHash, 'identical config must produce identical hash');
    });

    it('produces different sourceHash for different configuration', () => {
      const r1 = new FeatureFlagRegistry();
      r1.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'shadow', AWKN_INTENT_ROUTER_V1: 'shadow' });
      const s1 = r1.freeze();

      const r2 = new FeatureFlagRegistry();
      r2.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'enforce', AWKN_INTENT_ROUTER_V1: 'enforce' });
      const s2 = r2.freeze();

      assert.notEqual(s1.sourceHash, s2.sourceHash);
    });

    it('records the source for each flag in sourceVersions', () => {
      registry.applyEnv({ AWKN_INPUT_GATEWAY_V1: 'shadow' });
      registry.applyConfig({ AWKN_INTENT_ROUTER_V1: 'shadow' });
      // Context stays at code-default, but Input must be >= shadow for Intent dependency
      // Input=shadow (env), Intent=shadow (deploy-config), Context=0 (code-default)
      // Context='0' does not trigger dependency check, so freeze succeeds.
      const snapshot = registry.freeze();
      assert.equal(snapshot.sourceVersions.AWKN_INPUT_GATEWAY_V1, 'env');
      assert.equal(snapshot.sourceVersions.AWKN_INTENT_ROUTER_V1, 'deploy-config');
      assert.equal(snapshot.sourceVersions.AWKN_CONTEXT_PLANNER_V1, 'code-default');
    });

    it('passes Zod schema validation', () => {
      const snapshot = registry.freeze();
      const result = FeatureFlagSnapshotSchema.safeParse(snapshot);
      assert.ok(result.success, `snapshot must pass Zod validation: ${JSON.stringify(result.error)}`);
    });

    it('rejects snapshot with invalid schema via Zod', () => {
      const snapshot = registry.freeze();
      const tampered = { ...snapshot, schema: 'wrong-schema/v2' };
      const result = FeatureFlagSnapshotSchema.safeParse(tampered);
      assert.equal(result.success, false);
    });
  });

  describe('FEATURE_FLAG_DEPENDENCIES constant', () => {
    it('declares Intent depends on Input >= shadow', () => {
      const intentDep = FEATURE_FLAG_DEPENDENCIES.find((d) => d.flag === 'AWKN_INTENT_ROUTER_V1');
      assert.ok(intentDep);
      assert.deepEqual(intentDep.requires, [
        { flag: 'AWKN_INPUT_GATEWAY_V1', minimumValue: 'shadow' },
      ]);
    });

    it('declares Context depends on Intent >= shadow', () => {
      const contextDep = FEATURE_FLAG_DEPENDENCIES.find((d) => d.flag === 'AWKN_CONTEXT_PLANNER_V1');
      assert.ok(contextDep);
      assert.deepEqual(contextDep.requires, [
        { flag: 'AWKN_INTENT_ROUTER_V1', minimumValue: 'shadow' },
      ]);
    });
  });
});
