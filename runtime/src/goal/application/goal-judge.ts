import {
  GoalJudgeInputSchema,
  GoalJudgementSchema,
  type EvaluationStatus,
  type GoalJudgeInput,
  type GoalJudgement,
  type ObjectRef,
} from '../../contracts/public.js';

interface RequiredCheck {
  status: EvaluationStatus | 'MISSING';
}

function verdictFor(checks: readonly RequiredCheck[]): GoalJudgement['verdict'] {
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'FAIL')) return 'NOT_ACHIEVED';
  if (checks.some((check) => check.status === 'UNKNOWN' || check.status === 'MISSING')) return 'UNKNOWN';
  return 'ACHIEVED';
}

export function judgeGoal(value: GoalJudgeInput): GoalJudgement {
  const input = GoalJudgeInputSchema.parse(value);
  const acceptanceById = new Map(
    input.acceptanceEvaluations.map((evaluation) => [evaluation.criterionId, evaluation]),
  );
  const constraintById = new Map(
    input.constraintEvaluations.map((evaluation) => [evaluation.constraintId, evaluation]),
  );
  const gateByType = new Map(
    input.gateEvaluations.map((evaluation) => [evaluation.gateType, evaluation]),
  );
  const deliveryById = new Map(
    input.deliveryPreconditions.map((evaluation) => [evaluation.preconditionId, evaluation]),
  );
  const evidenceById = new Map(
    input.evidenceRecords.map((evidence) => [evidence.evidenceId, evidence]),
  );
  const bindingBySource = new Map(
    input.evidenceBindings.map((binding) => [binding.sourceId, binding]),
  );

  const checks: RequiredCheck[] = [];
  const acceptanceResults: ObjectRef[] = [];
  const requiredCriteria = input.goal.judgePolicy.requireAllAcceptanceCriteria
    ? input.goal.acceptanceCriteria
    : input.goal.acceptanceCriteria.filter((criterion) => criterion.required);
  for (const criterion of requiredCriteria) {
    const evaluation = acceptanceById.get(criterion.criterionId);
    checks.push({ status: evaluation?.status ?? 'MISSING' });
    if (evaluation !== undefined) acceptanceResults.push(evaluation.resultRef);
  }

  const constraintResults: ObjectRef[] = [];
  const requiredConstraints = input.goal.judgePolicy.requireAllHardConstraints
    ? input.goal.constraints.filter((constraint) => constraint.severity === 'HARD')
    : [];
  for (const constraint of requiredConstraints) {
    const evaluation = constraintById.get(constraint.constraintId);
    checks.push({ status: evaluation?.status ?? 'MISSING' });
    if (evaluation !== undefined) constraintResults.push(evaluation.resultRef);
  }

  const gateReceiptIds: string[] = [];
  for (const gateType of input.goal.judgePolicy.requiredGateTypes) {
    const evaluation = gateByType.get(gateType);
    checks.push({ status: evaluation?.status ?? 'MISSING' });
    if (evaluation !== undefined) gateReceiptIds.push(evaluation.receiptId);
  }

  const evidenceIds: string[] = [];
  for (const source of input.goal.evidenceSources.filter((candidate) => candidate.required)) {
    const binding = bindingBySource.get(source.sourceId);
    if (binding === undefined) {
      checks.push({ status: 'MISSING' });
      continue;
    }
    const evidence = evidenceById.get(binding.evidenceId);
    if (evidence === undefined) {
      checks.push({ status: 'MISSING' });
      continue;
    }
    const minimumLevel = Math.max(
      source.minimumLevel,
      input.goal.judgePolicy.minimumEvidenceLevel,
    );
    checks.push({ status: evidence.level >= minimumLevel ? 'PASS' : 'FAIL' });
    evidenceIds.push(evidence.evidenceId);
  }

  const deliveryPreconditionResults: ObjectRef[] = [];
  for (const precondition of input.deliveryPreconditions.filter((candidate) => candidate.required)) {
    const evaluation = deliveryById.get(precondition.preconditionId);
    checks.push({ status: evaluation?.status ?? 'MISSING' });
    if (evaluation !== undefined) deliveryPreconditionResults.push(evaluation.resultRef);
  }

  return GoalJudgementSchema.parse({
    schema: 'awkn-goal-judgement/v1',
    goalId: input.goal.goalId,
    runId: input.runId,
    verdict: verdictFor(checks),
    acceptanceResults,
    constraintResults,
    gateReceiptIds,
    evidenceIds,
    deliveryPreconditionResults,
    judgeVersion: input.judgeVersion,
    judgedAt: input.judgedAt,
  });
}
