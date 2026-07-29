import type { ReviewScopeSpec, ReviewTarget } from '../../../contracts/public.js';

export interface ReviewScopeRequest {
  readonly repositoryRoot: string;
  readonly mode: ReviewTarget['mode'];
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly includePatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
}

export interface ReviewSpecProviderPort {
  readonly provider: ReviewScopeSpec['provider'];
  createScope(request: ReviewScopeRequest): Promise<ReviewScopeSpec>;
}
