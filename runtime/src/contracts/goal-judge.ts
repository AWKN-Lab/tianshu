import { z } from 'zod';
import { ObjectRefSchema } from './actors.js';
import { EvidenceRecordSchema } from './evidence.js';
import { GoalSpecSchema } from './goal.js';
import { awknIdSchema } from './ids.js';
import { UtcTimestampSchema } from './time.js';

export const EvaluationStatusSchema = z.enum(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

export const AcceptanceEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: EvaluationStatusSchema,
  resultRef: ObjectRefSchema,
}).strict();
export type AcceptanceEvaluation = z.infer<typeof AcceptanceEvaluationSchema>;

export const ConstraintEvaluationSchema = z.object({
  constraintId: z.string().min(1),
  status: EvaluationStatusSchema,
  resultRef: ObjectRefSchema,
}).strict();
export type ConstraintEvaluation = z.infer<typeof ConstraintEvaluationSchema>;

export const GateEvaluationSchema = z.object({
  gateType: z.string().min(1),
  status: EvaluationStatusSchema,
  receiptId: awknIdSchema('rcpt'),
}).strict();
export type GateEvaluation = z.infer<typeof GateEvaluationSchema>;

export const DeliveryPreconditionEvaluationSchema = z.object({
  preconditionId: z.string().min(1),
  status: EvaluationStatusSchema,
  resultRef: ObjectRefSchema,
}).strict();
export type DeliveryPreconditionEvaluation = z.infer<typeof DeliveryPreconditionEvaluationSchema>;

export const EvidenceSourceBindingSchema = z.object({
  sourceId: z.string().min(1),
  evidenceId: awknIdSchema('ev'),
}).strict();
export type EvidenceSourceBinding = z.infer<typeof EvidenceSourceBindingSchema>;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function rejectDuplicates(
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
  values: readonly string[],
): void {
  const found = duplicates(values);
  if (found.length === 0) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `duplicate ${label}: ${found.join(', ')}`,
  });
}

export const GoalJudgeInputSchema = z.object({
  schema: z.literal('awkn-goal-judge-input/v1'),
  goal: GoalSpecSchema,
  runId: awknIdSchema('run'),
  acceptanceEvaluations: z.array(AcceptanceEvaluationSchema),
  constraintEvaluations: z.array(ConstraintEvaluationSchema),
  gateEvaluations: z.array(GateEvaluationSchema),
  requiredDeliveryPreconditionIds: z.array(z.string().min(1)),
  deliveryPreconditions: z.array(DeliveryPreconditionEvaluationSchema),
  evidenceRecords: z.array(EvidenceRecordSchema),
  evidenceBindings: z.array(EvidenceSourceBindingSchema),
  judgeVersion: z.string().min(1),
  judgedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  rejectDuplicates(
    context,
    ['acceptanceEvaluations'],
    'criterion evaluation',
    value.acceptanceEvaluations.map((item) => item.criterionId),
  );
  rejectDuplicates(
    context,
    ['constraintEvaluations'],
    'constraint evaluation',
    value.constraintEvaluations.map((item) => item.constraintId),
  );
  rejectDuplicates(
    context,
    ['gateEvaluations'],
    'gate evaluation',
    value.gateEvaluations.map((item) => item.gateType),
  );
  rejectDuplicates(
    context,
    ['gateEvaluations'],
    'gate receipt',
    value.gateEvaluations.map((item) => item.receiptId),
  );
  rejectDuplicates(
    context,
    ['requiredDeliveryPreconditionIds'],
    'required delivery precondition',
    value.requiredDeliveryPreconditionIds,
  );
  rejectDuplicates(
    context,
    ['deliveryPreconditions'],
    'delivery precondition evaluation',
    value.deliveryPreconditions.map((item) => item.preconditionId),
  );
  rejectDuplicates(
    context,
    ['evidenceRecords'],
    'evidence record',
    value.evidenceRecords.map((item) => item.evidenceId),
  );
  rejectDuplicates(
    context,
    ['evidenceBindings'],
    'evidence source binding',
    value.evidenceBindings.map((item) => item.sourceId),
  );

  const evidenceIds = new Set(value.evidenceRecords.map((item) => item.evidenceId));
  for (const [index, binding] of value.evidenceBindings.entries()) {
    if (!evidenceIds.has(binding.evidenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceBindings', index, 'evidenceId'],
        message: `evidence binding references unknown evidence: ${binding.evidenceId}`,
      });
    }
  }

  for (const [index, evidence] of value.evidenceRecords.entries()) {
    if (evidence.runId !== undefined && evidence.runId !== value.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceRecords', index, 'runId'],
        message: 'evidence runId must match Goal Judge runId',
      });
    }
  }
});
export type GoalJudgeInput = z.infer<typeof GoalJudgeInputSchema>;
