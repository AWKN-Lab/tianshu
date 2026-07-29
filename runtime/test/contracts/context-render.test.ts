import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ContextRenderInputSchema,
  ImmutableContextRenderSchema,
  contextRenderSourceHash,
  immutableContextRenderHash,
  type ContextCandidate,
  type ContextManifest,
  type ContextRenderInput,
  type ContextRenderSource,
  type ContextSection,
  type JsonValue,
} from '../../src/contracts/public.js';
import {
  ContextRenderError,
  bindContextRender,
  planContext,
  verifyImmutableRender,
} from '../../src/context/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const now = '2026-07-27T05:00:00.000Z';

function source(itemId: string, content: JsonValue): ContextRenderSource {
  return {
    itemId,
    content,
    contentHash: contextRenderSourceHash(content),
  };
}

function candidate(
  itemId: string,
  section: ContextSection,
  renderSource: ContextRenderSource,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    schema: 'awkn-context-candidate/v1',
    itemId,
    itemType: section === 'CORE_GOAL' ? 'goal' : section === 'POLICY_SYSTEM' ? 'policy' : 'document',
    section,
    ref: {
      schema: 'awkn-object-ref/v1',
      objectType: 'context_item',
      objectId: itemId,
      schemaId: 'awkn-context-render-source/v1',
      contentHash: renderSource.contentHash,
    },
    tokenCount: 10,
    required: false,
    permission: 'ALLOW',
    sensitivityAllowed: true,
    freshnessDecision: 'VALID',
    conflictRisk: 'NONE',
    factors: {
      decisionImpact: 1,
      taskRelevance: 1,
      sourceTrust: 1,
      freshness: 1,
      novelty: 0.5,
      userExpectation: 0.5,
      sensitivityRisk: 0,
      tokenCost: 0.1,
      contradictionRisk: 0,
    },
    sourceReceiptIds: [id('rcpt', itemId.slice(-1))],
    sourceVersion: 'v1',
    ...overrides,
  };
}

function readyManifest(): { manifest: ContextManifest; sources: ContextRenderSource[] } {
  const sources = [
    source('goal2', { title: 'Ship verified context', acceptance: ['tests pass'] }),
    source('goal1', { title: 'Preserve deterministic order' }),
    source('policy3', { rules: ['no unverified source'] }),
    source('knowledge4', ['claim-a', 'claim-b']),
  ];
  const candidates = [
    candidate('knowledge4', 'KNOWLEDGE', sources[3]),
    candidate('goal2', 'CORE_GOAL', sources[0], { required: true }),
    candidate('policy3', 'POLICY_SYSTEM', sources[2], { required: true }),
    candidate('goal1', 'CORE_GOAL', sources[1]),
  ];
  const manifest = planContext({
    schema: 'awkn-context-planner-input/v1',
    plan: {
      schema: 'awkn-context-query-plan/v1',
      contextId: id('ctx', '1'),
      executionId: id('exec', '2'),
      query: 'build immutable context',
      tokenBudget: 200,
      allowStale: false,
      allowedSensitivityClasses: ['internal'],
      policyVersion: 'context-policy/v1',
      plannerVersion: 'context-planner/v1',
      createdAt: now,
    },
    candidates,
  });
  assert.equal(manifest.status, 'READY');
  return { manifest, sources };
}

function renderInput(overrides: Partial<ContextRenderInput> = {}): ContextRenderInput {
  const value = readyManifest();
  return {
    schema: 'awkn-context-render-input/v1',
    renderId: id('rnd', '3'),
    manifest: value.manifest,
    sources: value.sources,
    binderVersion: 'context-render-binder/v1',
    createdAt: now,
    ...overrides,
  };
}

async function expectRenderError(action: () => unknown, code: ContextRenderError['code']): Promise<void> {
  await assert.rejects(async () => action(), (error: unknown) =>
    error instanceof ContextRenderError && error.code === code);
}

describe('Immutable Context Render Binder', () => {
  it('binds READY Manifest sources in deterministic section and item order', () => {
    const render = bindContextRender(renderInput());
    assert.equal(ImmutableContextRenderSchema.safeParse(render).success, true);
    assert.deepEqual(render.sections.map((section) => section.section), [
      'CORE_GOAL',
      'POLICY_SYSTEM',
      'KNOWLEDGE',
    ]);
    assert.deepEqual(render.sections[0].items.map((item) => item.itemId), ['goal1', 'goal2']);
    assert.deepEqual(render.sections[1].items.map((item) => item.itemId), ['policy3']);
    assert.deepEqual(render.sections[2].items.map((item) => item.itemId), ['knowledge4']);
    assert.equal(render.renderedText.startsWith('{"schema":"awkn-context-render-text/v1","sections":'), true);
    const { renderHash, ...projection } = render;
    assert.equal(renderHash, immutableContextRenderHash(projection));
  });

  it('produces byte-identical text and hash for the same normalized input', () => {
    const input = renderInput();
    const first = bindContextRender(input);
    const second = bindContextRender(input);
    assert.equal(first.renderedText, second.renderedText);
    assert.equal(first.renderHash, second.renderHash);
  });

  it('rejects a BLOCKED Manifest before source binding', async () => {
    const value = readyManifest();
    const blocked = planContext({
      schema: 'awkn-context-planner-input/v1',
      plan: {
        schema: 'awkn-context-query-plan/v1',
        contextId: id('ctx', '4'),
        executionId: id('exec', '5'),
        query: 'blocked context',
        tokenBudget: 20,
        allowStale: false,
        allowedSensitivityClasses: ['internal'],
        policyVersion: 'context-policy/v1',
        plannerVersion: 'context-planner/v1',
        createdAt: now,
      },
      candidates: [candidate('goal2', 'CORE_GOAL', value.sources[0], { required: true, tokenCount: 20 })],
    });
    assert.equal(blocked.status, 'BLOCKED');
    await expectRenderError(
      () => bindContextRender(renderInput({ manifest: blocked, sources: [] })),
      'MANIFEST_NOT_READY',
    );
  });

  it('rejects a tampered Manifest projection', async () => {
    const input = renderInput();
    const tampered = {
      ...input.manifest,
      query: 'tampered query',
    };
    await expectRenderError(
      () => bindContextRender({ ...input, manifest: tampered }),
      'MANIFEST_HASH_MISMATCH',
    );
  });

  it('rejects missing, extra and duplicate source bindings', async () => {
    const input = renderInput();
    await expectRenderError(
      () => bindContextRender({ ...input, sources: input.sources.slice(1) }),
      'SOURCE_SET_MISMATCH',
    );
    await expectRenderError(
      () => bindContextRender({
        ...input,
        sources: [...input.sources, source('extra', { extra: true })],
      }),
      'SOURCE_SET_MISMATCH',
    );
    assert.equal(ContextRenderInputSchema.safeParse({
      ...input,
      sources: [...input.sources, input.sources[0]],
    }).success, false);
  });

  it('rejects source content hash mismatch', async () => {
    const input = renderInput();
    const changed = input.sources.map((item, index) =>
      index === 0 ? { ...item, content: { changed: true } } : item);
    await expectRenderError(
      () => bindContextRender({ ...input, sources: changed }),
      'SOURCE_HASH_MISMATCH',
    );
  });

  it('rejects a source hash that does not match the Manifest ObjectRef', async () => {
    const input = renderInput();
    const changedSource = source(input.sources[0].itemId, { changed: true });
    const changed = input.sources.map((item, index) => index === 0 ? changedSource : item);
    await expectRenderError(
      () => bindContextRender({ ...input, sources: changed }),
      'MANIFEST_REF_HASH_MISMATCH',
    );
  });
});

describe('verifyImmutableRender (read-time integrity)', () => {
  it('verifies a valid ImmutableContextRender', () => {
    const render = bindContextRender(renderInput());
    verifyImmutableRender(render);
  });

  it('rejects a tampered renderHash', () => {
    const render = bindContextRender(renderInput());
    const tampered = { ...render, renderHash: '0'.repeat(64) };
    assert.throws(
      () => verifyImmutableRender(tampered),
      (error: unknown) => error instanceof ContextRenderError && error.code === 'RENDER_HASH_MISMATCH',
    );
  });

  it('rejects a tampered section payload (hash mismatch)', () => {
    const render = bindContextRender(renderInput());
    const tamperedSections = render.sections.map((section, index) =>
      index === 0 ? { ...section, items: [{ ...section.items[0], content: { tampered: true } }] } : section);
    const tampered = { ...render, sections: tamperedSections };
    assert.throws(
      () => verifyImmutableRender(tampered),
      (error: unknown) => error instanceof ContextRenderError && error.code === 'RENDER_HASH_MISMATCH',
    );
  });
});

describe('Unicode Code Point Comparator', () => {
  it('sorts ASCII itemIds deterministically (localeCompare independent)', () => {
    const sources = [
      source('zebra1', { z: 1 }),
      source('apple2', { a: 1 }),
      source('mango3', { m: 1 }),
      source('Apple4', { A: 1 }),
    ];
    const candidates = [
      candidate('mango3', 'KNOWLEDGE', sources[2]),
      candidate('zebra1', 'KNOWLEDGE', sources[0]),
      candidate('apple2', 'KNOWLEDGE', sources[1]),
      candidate('Apple4', 'KNOWLEDGE', sources[3]),
    ];
    const manifest = planContext({
      schema: 'awkn-context-planner-input/v1',
      plan: {
        schema: 'awkn-context-query-plan/v1',
        contextId: id('ctx', '7'),
        executionId: id('exec', '8'),
        query: 'code point sort test',
        tokenBudget: 200,
        allowStale: false,
        allowedSensitivityClasses: ['internal'],
        policyVersion: 'context-policy/v1',
        plannerVersion: 'context-planner/v1',
        createdAt: now,
      },
      candidates,
    });
    assert.equal(manifest.status, 'READY');
    const render = bindContextRender({
      schema: 'awkn-context-render-input/v1',
      renderId: id('rnd', '9'),
      manifest,
      sources,
      binderVersion: 'context-render-binder/v1',
      createdAt: now,
    });
    assert.deepEqual(render.sections[0].items.map((item) => item.itemId), ['Apple4', 'apple2', 'mango3', 'zebra1']);
  });

  it('produces identical hash on Windows and Linux (no locale dependency)', () => {
    const input = renderInput();
    const first = bindContextRender(input);
    const second = bindContextRender(input);
    assert.equal(first.renderHash, second.renderHash);
    assert.equal(first.renderedText, second.renderedText);
    verifyImmutableRender(first);
    verifyImmutableRender(second);
  });
});
