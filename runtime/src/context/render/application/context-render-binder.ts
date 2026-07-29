import {
  ContextRenderInputSchema,
  ContextRenderItemSchema,
  ContextRenderSectionSchema,
  ImmutableContextRenderSchema,
  contextManifestHash,
  contextRenderSourceHash,
  contextRenderText,
  immutableContextRenderHash,
  type ContextRenderInput,
  type ContextRenderItem,
  type ContextRenderSection,
  type ContextSection,
  type ImmutableContextRender,
} from '../../../contracts/public.js';

export type ContextRenderErrorCode =
  | 'MANIFEST_NOT_READY'
  | 'MANIFEST_HASH_MISMATCH'
  | 'SOURCE_SET_MISMATCH'
  | 'SOURCE_HASH_MISMATCH'
  | 'MANIFEST_REF_HASH_MISMATCH'
  | 'RENDER_HASH_MISMATCH'
  | 'SECTION_ORDER_VIOLATION'
  | 'ITEM_DUPLICATE_ACROSS_SECTIONS'
  | 'ITEMS_NOT_SORTED';

export class ContextRenderError extends Error {
  constructor(readonly code: ContextRenderErrorCode, message: string) {
    super(message);
    this.name = 'ContextRenderError';
  }
}

const SECTION_ORDER: readonly ContextSection[] = [
  'CORE_GOAL',
  'POLICY_SYSTEM',
  'HIGH_IMPACT_CLAIM',
  'KNOWLEDGE',
  'TOOL_SKILL',
];

/**
 * Deterministic Unicode Code Point Comparator.
 *
 * Replaces localeCompare() which depends on runtime locale and may produce
 * different orderings on Windows vs Linux, breaking cross-platform Hash
 * determinism. This comparator iterates by Unicode code point (not UTF-16
 * code unit), ensuring consistent ordering for all valid itemId strings
 * including those with astral-plane characters.
 */
function compareByCodePoint(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const len = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < len; i++) {
    const aCode = aPoints[i].codePointAt(0)!;
    const bCode = bPoints[i].codePointAt(0)!;
    if (aCode !== bCode) return aCode - bCode;
  }
  return aPoints.length - bPoints.length;
}

function assertManifestHash(input: ContextRenderInput): void {
  const { manifestHash, ...projection } = input.manifest;
  if (contextManifestHash(projection) !== manifestHash) {
    throw new ContextRenderError('MANIFEST_HASH_MISMATCH', 'Context Manifest hash does not match its projection');
  }
}

function assertExactSourceSet(input: ContextRenderInput): Map<string, ContextRenderInput['sources'][number]> {
  const includedIds = input.manifest.included.map((item) => item.itemId).sort();
  const sourceIds = input.sources.map((source) => source.itemId).sort();
  if (includedIds.length !== sourceIds.length || includedIds.some((itemId, index) => itemId !== sourceIds[index])) {
    throw new ContextRenderError(
      'SOURCE_SET_MISMATCH',
      `Render sources must exactly match included Manifest items: included=${includedIds.join(',')} sources=${sourceIds.join(',')}`,
    );
  }
  return new Map(input.sources.map((source) => [source.itemId, source]));
}

export function bindContextRender(value: ContextRenderInput): ImmutableContextRender {
  const input = ContextRenderInputSchema.parse(value);
  if (input.manifest.status !== 'READY') {
    throw new ContextRenderError('MANIFEST_NOT_READY', 'BLOCKED Context Manifest cannot be rendered');
  }
  assertManifestHash(input);
  const sourceById = assertExactSourceSet(input);

  const itemsBySection = new Map<ContextSection, ContextRenderItem[]>(
    SECTION_ORDER.map((section) => [section, []]),
  );
  const orderedIncluded = [...input.manifest.included].sort((left, right) => {
    const section = SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section);
    return section !== 0 ? section : compareByCodePoint(left.itemId, right.itemId);
  });

  for (const included of orderedIncluded) {
    const source = sourceById.get(included.itemId);
    if (source === undefined) {
      throw new ContextRenderError('SOURCE_SET_MISMATCH', `missing source for ${included.itemId}`);
    }
    const computedHash = contextRenderSourceHash(source.content);
    if (computedHash !== source.contentHash) {
      throw new ContextRenderError(
        'SOURCE_HASH_MISMATCH',
        `source content hash mismatch for ${included.itemId}`,
      );
    }
    if (source.contentHash !== included.ref.contentHash) {
      throw new ContextRenderError(
        'MANIFEST_REF_HASH_MISMATCH',
        `source hash does not match Manifest ObjectRef for ${included.itemId}`,
      );
    }
    const renderItem = ContextRenderItemSchema.parse({
      itemId: included.itemId,
      itemType: included.itemType,
      section: included.section,
      content: source.content,
      contentHash: source.contentHash,
      sourceReceiptIds: included.sourceReceiptIds,
      sourceVersion: included.sourceVersion,
    });
    itemsBySection.get(included.section)!.push(renderItem);
  }

  const sections: ContextRenderSection[] = SECTION_ORDER
    .map((section) => ContextRenderSectionSchema.parse({
      section,
      items: (itemsBySection.get(section) ?? []).sort((left, right) => compareByCodePoint(left.itemId, right.itemId)),
    }))
    .filter((section) => section.items.length > 0);
  assertCrossFieldInvariants(sections);
  const renderedText = contextRenderText(sections);
  const base = {
    schema: 'awkn-immutable-context-render/v1' as const,
    renderId: input.renderId,
    contextId: input.manifest.contextId,
    executionId: input.manifest.executionId,
    manifestHash: input.manifest.manifestHash,
    sections,
    renderedText,
    binderVersion: input.binderVersion,
    createdAt: input.createdAt,
  };
  return ImmutableContextRenderSchema.parse({
    ...base,
    renderHash: immutableContextRenderHash(base),
  });
}

/**
 * Verifies cross-field invariants after Render binding.
 *
 * Ensures:
 * - Sections follow SECTION_ORDER (no out-of-order sections)
 * - itemId is unique across all sections (no duplicates)
 * - Each section's items are sorted by Unicode code point
 *
 * These invariants protect the Render Hash: if any invariant is violated,
 * the rendered text would differ from a canonical re-rendering, breaking
 * cross-platform replayability.
 */
function assertCrossFieldInvariants(sections: readonly ContextRenderSection[]): void {
  let lastIndex = -1;
  for (const section of sections) {
    const currentIndex = SECTION_ORDER.indexOf(section.section);
    if (currentIndex === -1) {
      throw new ContextRenderError(
        'SECTION_ORDER_VIOLATION',
        `unknown section: ${section.section}`,
      );
    }
    if (currentIndex <= lastIndex) {
      throw new ContextRenderError(
        'SECTION_ORDER_VIOLATION',
        `section ${section.section} appears out of order (index ${currentIndex} after ${lastIndex})`,
      );
    }
    lastIndex = currentIndex;
  }

  const seenItemIds = new Set<string>();
  for (const section of sections) {
    for (let i = 1; i < section.items.length; i++) {
      if (compareByCodePoint(section.items[i - 1].itemId, section.items[i].itemId) >= 0) {
        throw new ContextRenderError(
          'ITEMS_NOT_SORTED',
          `items in section ${section.section} are not sorted by code point: ${section.items[i - 1].itemId} >= ${section.items[i].itemId}`,
        );
      }
    }
    for (const item of section.items) {
      if (seenItemIds.has(item.itemId)) {
        throw new ContextRenderError(
          'ITEM_DUPLICATE_ACROSS_SECTIONS',
          `itemId ${item.itemId} appears in multiple sections`,
        );
      }
      seenItemIds.add(item.itemId);
    }
  }
}

/**
 * Verifies an ImmutableContextRender on read/load.
 *
 * Call this when deserializing or loading a previously-stored Render to
 * ensure its integrity has not been tampered with. This recomputes the
 * renderHash and validates cross-field invariants, providing fail-closed
 * protection against partial corruption or malicious tampering.
 *
 * Throws ContextRenderError with code RENDER_HASH_MISMATCH if the stored
 * hash does not match the recomputed hash.
 */
export function verifyImmutableRender(render: ImmutableContextRender): void {
  const { renderHash, ...projection } = render;
  const computedHash = immutableContextRenderHash(projection);
  if (computedHash !== renderHash) {
    throw new ContextRenderError(
      'RENDER_HASH_MISMATCH',
      'ImmutableContextRender hash does not match its projection (possible tampering or corruption)',
    );
  }
  assertCrossFieldInvariants(render.sections);
}
