import { z } from 'zod';
import { ClaimSchema } from './claim.js';
import { awknIdSchema } from './ids.js';
import { UtcTimestampSchema } from './time.js';

const ScoreSchema = z.number().min(0).max(1);

export const ClaimPermissionDecisionSchema = z.enum(['ALLOW', 'DENY', 'UNKNOWN']);
export type ClaimPermissionDecision = z.infer<typeof ClaimPermissionDecisionSchema>;

export const ClaimFreshnessDecisionSchema = z.enum(['VALID', 'STALE', 'EXPIRED', 'UNKNOWN']);
export type ClaimFreshnessDecision = z.infer<typeof ClaimFreshnessDecisionSchema>;

export const ClaimImpactSchema = z.enum(['HIGH', 'LOW']);
export type ClaimImpact = z.infer<typeof ClaimImpactSchema>;

export const ClaimAssessmentSchema = z.object({
  claimId: awknIdSchema('clm'),
  fieldKey: z.string().min(1),
  impact: ClaimImpactSchema,
  permission: ClaimPermissionDecisionSchema,
  freshness: ClaimFreshnessDecisionSchema,
  assessedAuthority: ScoreSchema,
  isCurrent: z.boolean(),
  assessedAt: UtcTimestampSchema,
}).strict();
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;

export const ClaimExclusionSchema = z.object({
  claimId: awknIdSchema('clm'),
  reason: z.enum([
    'PERMISSION_DENIED',
    'PERMISSION_UNKNOWN',
    'EXPIRED',
    'FRESHNESS_UNKNOWN',
  ]),
}).strict();
export type ClaimExclusion = z.infer<typeof ClaimExclusionSchema>;

export const ClaimResolutionDecisionSchema = z.enum([
  'SINGLE',
  'COALESCED',
  'SUPERSEDE',
  'ASK_USER',
  'RETAIN_CONFLICT',
  'NO_USABLE_CLAIM',
]);
export type ClaimResolutionDecision = z.infer<typeof ClaimResolutionDecisionSchema>;

export const ClaimResolutionGroupSchema = z.object({
  fieldKey: z.string().min(1),
  decision: ClaimResolutionDecisionSchema,
  selectedClaimId: awknIdSchema('clm').optional(),
  equivalentClaimIds: z.array(awknIdSchema('clm')),
  supersededClaimIds: z.array(awknIdSchema('clm')),
  disputedClaimIds: z.array(awknIdSchema('clm')),
  reasonCodes: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, context) => {
  const allIds = [
    ...value.equivalentClaimIds,
    ...value.supersededClaimIds,
    ...value.disputedClaimIds,
  ];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'claim resolution ID lists cannot overlap',
    });
  }
  if (value.decision === 'NO_USABLE_CLAIM' && value.selectedClaimId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedClaimId'],
      message: 'NO_USABLE_CLAIM cannot select a claim',
    });
  }
  if (['SINGLE', 'COALESCED', 'SUPERSEDE'].includes(value.decision) && value.selectedClaimId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedClaimId'],
      message: `${value.decision} requires selectedClaimId`,
    });
  }
});
export type ClaimResolutionGroup = z.infer<typeof ClaimResolutionGroupSchema>;

export const ClaimStateTransitionSchema = z.object({
  claimId: awknIdSchema('clm'),
  toStatus: z.enum(['superseded', 'disputed']),
  reasonCode: z.string().min(1),
}).strict();
export type ClaimStateTransition = z.infer<typeof ClaimStateTransitionSchema>;

export const ClaimResolutionInputSchema = z.object({
  schema: z.literal('awkn-claim-resolution-input/v1'),
  claims: z.array(ClaimSchema).min(1),
  assessments: z.array(ClaimAssessmentSchema).min(1),
  dominanceThreshold: ScoreSchema,
  resolverVersion: z.string().min(1),
  resolvedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const claimIds = value.claims.map((claim) => claim.claimId);
  if (new Set(claimIds).size !== claimIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claims'],
      message: 'claims cannot contain duplicate claimId',
    });
  }
  const assessmentIds = value.assessments.map((assessment) => assessment.claimId);
  if (new Set(assessmentIds).size !== assessmentIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assessments'],
      message: 'assessments cannot contain duplicate claimId',
    });
  }
  const claims = new Set(claimIds);
  const assessments = new Set(assessmentIds);
  const missingAssessment = claimIds.filter((claimId) => !assessments.has(claimId));
  const unknownClaim = assessmentIds.filter((claimId) => !claims.has(claimId));
  if (missingAssessment.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assessments'],
      message: `claims missing assessment: ${missingAssessment.sort().join(', ')}`,
    });
  }
  if (unknownClaim.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assessments'],
      message: `assessments reference unknown claim: ${unknownClaim.sort().join(', ')}`,
    });
  }
});
export type ClaimResolutionInput = z.infer<typeof ClaimResolutionInputSchema>;

export const ClaimResolutionResultSchema = z.object({
  schema: z.literal('awkn-claim-resolution/v1'),
  usableClaimIds: z.array(awknIdSchema('clm')),
  exclusions: z.array(ClaimExclusionSchema),
  groups: z.array(ClaimResolutionGroupSchema),
  transitions: z.array(ClaimStateTransitionSchema),
  resolverVersion: z.string().min(1),
  resolvedAt: UtcTimestampSchema,
}).strict();
export type ClaimResolutionResult = z.infer<typeof ClaimResolutionResultSchema>;
