import {
  GoalFactoryInputSchema,
  GoalSpecSchema,
  type GoalFactoryInput,
  type GoalSpec,
} from '../../contracts/public.js';

export function buildGoalSpec(value: GoalFactoryInput): GoalSpec {
  const input = GoalFactoryInputSchema.parse(value);
  return GoalSpecSchema.parse({
    schema: 'awkn-goal-spec/v3',
    goalId: input.goalId,
    title: input.title,
    desiredState: input.desiredState,
    scope: input.scope,
    acceptanceCriteria: input.acceptanceCriteria,
    evidenceSources: input.evidenceSources,
    constraints: input.constraints,
    assumptions: input.assumptions,
    budget: input.budget,
    stopPolicy: input.stopPolicy,
    judgePolicy: input.judgePolicy,
    deliveryExpectation: input.deliveryExpectation,
    taskProfile: input.intent.taskProfile,
    riskLevel: input.riskLevel,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });
}
