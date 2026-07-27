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
  | 'MANIFEST_REF_HASH_MISMATCH';

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
    return section !== 0 ? section : left.itemId.localeCompare(right.itemId);
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
      items: (itemsBySection.get(section) ?? []).sort((left, right) => left.itemId.localeCompare(right.itemId)),
    }))
    .filter((section) => section.items.length > 0);
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
