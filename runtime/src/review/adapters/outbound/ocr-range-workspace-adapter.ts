import type { ReviewPlan, ReviewTarget } from '../../../contracts/public.js';
import type { ReviewScopeRequest, ReviewSpecProviderPort } from '../../ports/outbound/review-spec-provider-port.js';
import type { ReviewArtifactBundle, ReviewWorkspacePort } from '../../ports/outbound/review-workspace-port.js';
import { NativeGitReviewAdapter } from './native-git-review-adapter.js';

function requestFor(target: ReviewTarget): ReviewScopeRequest {
  if (target.mode !== 'COMMIT_RANGE' || target.baseRef === undefined || target.headRef === undefined) {
    throw new Error('OCR range workspace requires a COMMIT_RANGE target');
  }
  return {
    repositoryRoot: target.repositoryRoot,
    mode: 'COMMIT_RANGE',
    baseRef: target.baseRef,
    headRef: target.headRef,
    includePatterns: target.includePatterns,
    excludePatterns: target.excludePatterns,
  };
}

function fileProjection(files: readonly {
  path: string;
  oldPath?: string;
  status: string;
  insertions: number;
  deletions: number;
  diffFingerprint: string;
}[]): string {
  return JSON.stringify([...files]
    .map(({ path, oldPath, status, insertions, deletions, diffFingerprint }) => ({
      path,
      oldPath: oldPath ?? null,
      status,
      insertions,
      deletions,
      diffFingerprint,
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function assertContentBinding(
  ocrScope: Awaited<ReturnType<ReviewSpecProviderPort['createScope']>>,
  nativeScope: Awaited<ReturnType<ReviewSpecProviderPort['createScope']>>,
  nativeArtifacts: ReviewArtifactBundle,
): void {
  if (
    ocrScope.baseRef !== nativeScope.baseRef
    || ocrScope.headRef !== nativeScope.headRef
    || ocrScope.mergeBase !== nativeScope.mergeBase
  ) {
    throw new Error('OCR and Native Git disagree on frozen range commits');
  }
  if (ocrScope.diffFingerprint !== nativeScope.diffFingerprint) {
    throw new Error('OCR and Native Git disagree on frozen range content fingerprint');
  }
  if (fileProjection(ocrScope.files) !== fileProjection(nativeScope.files)) {
    throw new Error('OCR and Native Git disagree on frozen range file content');
  }
  const nativeFiles = new Map(nativeScope.files.map((file) => [file.path, file.diffFingerprint]));
  if (
    nativeArtifacts.targetFingerprint !== nativeScope.diffFingerprint
    || nativeArtifacts.files.length !== nativeFiles.size
    || nativeArtifacts.files.some((file) => nativeFiles.get(file.path) !== file.diffFingerprint)
  ) {
    throw new Error('Native Git artifacts are not bound to the Native Git scope');
  }
}

/** Uses OCR as range authority while Native Git supplies frozen patches. */
export class OcrRangeWorkspaceAdapter implements ReviewWorkspacePort {
  constructor(
    private readonly ocr: ReviewSpecProviderPort,
    private readonly native = new NativeGitReviewAdapter(),
  ) {}

  async freeze(target: ReviewTarget): Promise<ReviewArtifactBundle> {
    const request = requestFor(target);
    const [ocrScope, nativeScope, nativeArtifacts] = await Promise.all([
      this.ocr.createScope(request),
      this.native.createScope(request),
      this.native.freeze(target),
    ]);
    assertContentBinding(ocrScope, nativeScope, nativeArtifacts);
    return { ...nativeArtifacts, targetFingerprint: ocrScope.diffFingerprint };
  }

  async currentFingerprint(plan: ReviewPlan): Promise<string> {
    return (await this.ocr.createScope(requestFor(plan.target))).diffFingerprint;
  }
}
