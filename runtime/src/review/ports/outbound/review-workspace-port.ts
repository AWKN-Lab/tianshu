import type { ObjectRef, ReviewPlan, ReviewTarget } from '../../../contracts/public.js';

export interface ReviewFileArtifact {
  readonly path: string;
  readonly patch: string;
  readonly diffFingerprint: string;
  readonly objectRef?: ObjectRef;
}

export interface ReviewContractArtifact {
  readonly ref: ObjectRef;
  readonly content: string;
}

export interface ReviewArtifactBundle {
  readonly targetFingerprint: string;
  readonly files: readonly ReviewFileArtifact[];
  readonly contracts?: readonly ReviewContractArtifact[];
}

export interface ReviewWorkspacePort {
  freeze(target: ReviewTarget): Promise<ReviewArtifactBundle>;
  currentFingerprint(plan: ReviewPlan): Promise<string>;
}
