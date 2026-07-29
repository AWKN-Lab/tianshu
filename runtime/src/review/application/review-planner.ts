import {
  REVIEW_PLAN_SCHEMA,
  REVIEW_TARGET_SCHEMA,
  ReviewPlanSchema,
  ReviewTargetSchema,
  computeReviewPlanHash,
  computeReviewRuleBundleHash,
  deterministicReviewId,
  stableHash,
  type ObjectRef,
  type ReviewFile,
  type ReviewPlan,
  type ReviewRisk,
  type ReviewRuleGroup,
  type ReviewScopeSpec,
  type ReviewTarget,
  type ReviewUnit,
  type ReviewUnitType,
} from '../../contracts/public.js';
import type { ReviewTargetMetadata } from '../ports/inbound/review-service-port.js';

export class ReviewPlanningError extends Error {
  constructor(readonly code: 'TARGET_SCOPE_MISMATCH' | 'EMPTY_TARGET', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ReviewPlanningError';
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function riskForFile(file: ReviewFile): ReviewRisk {
  const path = file.path.toLowerCase();
  if (file.status === 'DELETED' || /(auth|permission|policy|migration|schema|route)/.test(path)) return 'HIGH';
  if (/(config|env|api|controller|database|model)/.test(path)) return 'MEDIUM';
  return 'LOW';
}

function unit(
  targetFingerprint: string,
  type: ReviewUnitType,
  purpose: string,
  paths: readonly string[],
  risk: ReviewRisk,
  ruleGroupIds: readonly string[],
  specRefs: readonly ObjectRef[],
): ReviewUnit {
  const normalizedPaths = sortedUnique(paths);
  const normalizedRules = sortedUnique(ruleGroupIds);
  const unitHash = stableHash('awkn-review-unit/v1', {
    targetFingerprint,
    type,
    purpose,
    paths: normalizedPaths,
    risk,
    ruleGroupIds: normalizedRules,
    specRefs,
  });
  return {
    unitId: deterministicReviewId('runit', unitHash),
    type,
    purpose,
    paths: normalizedPaths,
    risk,
    ruleGroupIds: normalizedRules,
    specRefs: [...specRefs],
    evidenceRefs: [],
  };
}

function normalizeStem(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  return name
    .replace(/\.(test|spec)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_.](controller|service|impl|types?|schema|model|route|routes)$/i, '')
    .toLowerCase();
}

interface Relation {
  readonly purpose: string;
  readonly left: RegExp;
  readonly right: RegExp;
  readonly risk: ReviewRisk;
}

const CROSS_FILE_RELATIONS: readonly Relation[] = [
  { purpose: 'API definition and implementation consistency', left: /(^|\/)(api|routes?|controllers?)(\/|\.)/i, right: /(^|\/)(services?|impl|handlers?)(\/|\.)/i, risk: 'HIGH' },
  { purpose: 'Schema and migration consistency', left: /(schema|models?|entities?)/i, right: /(migrations?|ddl|database)/i, risk: 'HIGH' },
  { purpose: 'Configuration definition and usage consistency', left: /(config|\.env|settings)/i, right: /(src|app|services?|runtime)/i, risk: 'MEDIUM' },
  { purpose: 'Permission declaration and route enforcement', left: /(auth|permission|policy|acl)/i, right: /(routes?|controllers?|handlers?)/i, risk: 'CRITICAL' },
  { purpose: 'Public type and downstream consumer compatibility', left: /(^|\/)(types?|interfaces?|contracts?)(\/|\.)/i, right: /(src|app|client|consumer|services?)/i, risk: 'HIGH' },
  { purpose: 'Error definition and caller handling', left: /(errors?|error-codes?)/i, right: /(controllers?|handlers?|services?|client)/i, risk: 'MEDIUM' },
  { purpose: 'Localization key and usage consistency', left: /(i18n|locales?|messages?)/i, right: /(ui|components?|pages?|views?)/i, risk: 'MEDIUM' },
];

function buildCrossFileUnits(target: ReviewTarget, files: readonly ReviewFile[]): ReviewUnit[] {
  const paths = files.filter((file) => file.willReview).map((file) => file.path);
  const results: ReviewUnit[] = [];

  for (const relation of CROSS_FILE_RELATIONS) {
    const left = paths.filter((path) => relation.left.test(path));
    const right = paths.filter((path) => relation.right.test(path));
    const related = sortedUnique([...left, ...right]);
    if (left.length > 0 && right.length > 0 && related.length > 1) {
      results.push(unit(target.diffFingerprint, 'CROSS_FILE', relation.purpose, related, relation.risk, [], target.specRefs));
    }
  }

  const tests = paths.filter((path) => /(^|\/)(__tests__|tests?)(\/|\.)|\.(test|spec)\./i.test(path));
  const implementations = paths.filter((path) => !tests.includes(path));
  for (const testPath of tests) {
    const stem = normalizeStem(testPath);
    const matches = implementations.filter((path) => normalizeStem(path) === stem);
    if (matches.length > 0) {
      results.push(unit(
        target.diffFingerprint,
        'CROSS_FILE',
        'Implementation and test consistency',
        [...matches, testPath],
        'HIGH',
        [],
        target.specRefs,
      ));
    }
  }

  return results;
}

export function createReviewTarget(
  scope: ReviewScopeSpec,
  metadata: ReviewTargetMetadata & { readonly mode: ReviewTarget['mode'] },
): ReviewTarget {
  const identityHash = stableHash(REVIEW_TARGET_SCHEMA, {
    mode: metadata.mode,
    repositoryRoot: scope.repositoryRoot,
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    diffFingerprint: scope.diffFingerprint,
    prdRefs: metadata.prdRefs ?? [],
    specRefs: metadata.specRefs ?? [],
    acceptanceCriteriaRefs: metadata.acceptanceCriteriaRefs ?? [],
    includePatterns: metadata.includePatterns ?? [],
    excludePatterns: metadata.excludePatterns ?? [],
  });
  return ReviewTargetSchema.parse({
    schema: REVIEW_TARGET_SCHEMA,
    targetId: deterministicReviewId('rtgt', identityHash),
    mode: metadata.mode,
    repositoryRoot: scope.repositoryRoot,
    baseRef: scope.baseRef,
    headRef: scope.headRef,
    mergeBase: scope.mergeBase,
    diffFingerprint: scope.diffFingerprint,
    prdRefs: metadata.prdRefs ?? [],
    specRefs: metadata.specRefs ?? [],
    acceptanceCriteriaRefs: metadata.acceptanceCriteriaRefs ?? [],
    includePatterns: metadata.includePatterns ?? [],
    excludePatterns: metadata.excludePatterns ?? [],
    initiator: metadata.initiator,
    implementer: metadata.implementer,
    createdAt: metadata.createdAt,
  });
}

export function buildReviewPlan(target: ReviewTarget, scope: ReviewScopeSpec, createdAt: string): ReviewPlan {
  if (
    target.repositoryRoot !== scope.repositoryRoot
    || target.baseRef !== scope.baseRef
    || target.headRef !== scope.headRef
    || target.mergeBase !== scope.mergeBase
    || target.diffFingerprint !== scope.diffFingerprint
  ) {
    throw new ReviewPlanningError('TARGET_SCOPE_MISMATCH', 'provider scope does not match frozen target');
  }
  if (scope.files.length === 0) {
    throw new ReviewPlanningError('EMPTY_TARGET', 'review target contains no changed files');
  }

  const files = [...scope.files].sort((left, right) => compareCodePoints(left.path, right.path));
  const ruleGroups: ReviewRuleGroup[] = [...scope.ruleGroups]
    .map((group) => ({ ...group, files: sortedUnique(group.files) }))
    .sort((left, right) => compareCodePoints(left.ruleGroupId, right.ruleGroupId));
  const reviewable = files.filter((file) => file.willReview);
  const units: ReviewUnit[] = reviewable.map((file) => unit(
    target.diffFingerprint,
    'FILE',
    `Review changed file ${file.path}`,
    [file.path],
    riskForFile(file),
    file.ruleGroupIds,
    target.specRefs,
  ));

  for (const file of reviewable) {
    if (/(^|\/)(__tests__|tests?)(\/|\.)|\.(test|spec)\./i.test(file.path)) {
      units.push(unit(
        target.diffFingerprint,
        'TEST_ABUSE',
        `Verify test effectiveness and anti-cheating for ${file.path}`,
        [file.path],
        'HIGH',
        file.ruleGroupIds,
        target.specRefs,
      ));
    }
  }
  units.push(...buildCrossFileUnits(target, files));
  if ((target.prdRefs.length + target.specRefs.length + target.acceptanceCriteriaRefs.length) > 0 && reviewable.length > 0) {
    units.push(unit(
      target.diffFingerprint,
      'SPEC',
      'Validate implementation against PRD, specification, and acceptance criteria',
      reviewable.map((file) => file.path),
      'HIGH',
      [],
      [...target.prdRefs, ...target.specRefs, ...target.acceptanceCriteriaRefs],
    ));
  }

  const deduplicatedUnits = [...new Map(units.map((item) => [item.unitId, item])).values()]
    .sort((left, right) => compareCodePoints(left.unitId, right.unitId));
  const base = {
    target,
    provider: scope.provider,
    providerVersion: scope.providerVersion,
    ruleBundleHash: computeReviewRuleBundleHash(ruleGroups),
    files,
    ruleGroups,
    units: deduplicatedUnits,
  };
  const planHash = computeReviewPlanHash(base);
  return ReviewPlanSchema.parse({
    schema: REVIEW_PLAN_SCHEMA,
    planId: deterministicReviewId('rplan', planHash),
    ...base,
    planHash,
    createdAt,
  });
}
