import {
  IntentDecisionSchema,
  IntentReceiptPayloadSchema,
  IntentRouterInputSchema,
  type ExecutionLevel,
  type IntentAssumption,
  type IntentDecision,
  type IntentReceiptPayload,
  type IntentRouterInput,
  type TaskProfileId,
} from '../../contracts/public.js';
import { evaluateClarification } from '../domain/clarification-value.js';

export interface RouteIntentCommand {
  intentId: string;
  input: IntentRouterInput;
  routedAt: string;
}

function selectLevel(input: IntentRouterInput): ExecutionLevel {
  if (input.multiAgent || input.operations.includes('ORCHESTRATE') || input.dependencyCount >= 2) {
    return 'L4';
  }
  if (input.timeDependency !== 'none') {
    return 'L3';
  }
  if (input.iterative) {
    return 'L2';
  }
  if (
    input.toolCountHint > 0
    || input.externalSideEffects
    || input.operations.some((operation) => operation === 'WRITE'
      || operation === 'SEND'
      || operation === 'DELETE')
  ) {
    return 'L1';
  }
  return 'L0';
}

function selectTaskProfile(input: IntentRouterInput, level: ExecutionLevel): TaskProfileId {
  if (level === 'L4') return 'multi_agent_orchestration';
  if (level === 'L3') {
    return input.operations.includes('MONITOR') ? 'scheduled_check' : 'automation';
  }
  return input.taskKind;
}

function buildAssumptions(input: IntentRouterInput, decision: string): IntentAssumption[] {
  if (decision !== 'CONTINUE_WITH_EXPLICIT_ASSUMPTION') return [];
  return input.missingFields
    .map((field) => ({
      fieldId: field.fieldId,
      description: `Proceed with ${field.fieldId} unresolved: ${field.description}`,
      confidence: Math.round((1 - Math.max(field.answerImpact, field.uncertaintyReduction)) * 1_000_000) / 1_000_000,
    }))
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function reasonCodes(
  input: IntentRouterInput,
  level: ExecutionLevel,
  clarificationDecision: string,
): string[] {
  const reasons = new Set<string>();
  reasons.add(`EXECUTION_${level}`);

  if (level === 'L0') reasons.add('STATIC_NO_TOOL_EXECUTION');
  if (level === 'L1') reasons.add('SINGLE_EXECUTION_PATH');
  if (level === 'L2') reasons.add('ITERATIVE_EXECUTION');
  if (level === 'L3') reasons.add('TIME_DEPENDENT_EXECUTION');
  if (level === 'L4') reasons.add('MULTI_AGENT_OR_DEPENDENCY_GRAPH');
  if (input.deterministicAcceptance) reasons.add('DETERMINISTIC_ACCEPTANCE_AVAILABLE');
  if (input.externalSideEffects) reasons.add('EXTERNAL_SIDE_EFFECTS');
  if (clarificationDecision === 'ASK_USER') reasons.add('CLARIFICATION_REQUIRED');
  if (clarificationDecision === 'CONTINUE_WITH_EXPLICIT_ASSUMPTION') reasons.add('EXPLICIT_ASSUMPTION_REQUIRED');
  if (input.missingFields.some((field) => field.mandatoryReason !== undefined)) {
    reasons.add('MANDATORY_FIELD_MISSING');
  }
  return [...reasons].sort();
}

export function routeIntent(command: RouteIntentCommand): IntentDecision {
  const input = IntentRouterInputSchema.parse(command.input);
  const clarification = evaluateClarification(input.missingFields);
  const executionLevel = selectLevel(input);
  const persistentRunRequired = executionLevel === 'L2'
    || executionLevel === 'L3'
    || executionLevel === 'L4';
  const assumptions = buildAssumptions(input, clarification.decision);

  return IntentDecisionSchema.parse({
    schema: 'awkn-intent-decision/v1',
    intentId: command.intentId,
    inputId: input.inputId,
    executionLevel,
    primaryIntent: input.primaryIntent,
    secondaryIntents: input.secondaryIntents,
    requestedOutcome: input.requestedOutcome,
    deliverableTypes: input.deliverableTypes,
    externalSideEffects: input.externalSideEffects,
    timeDependency: input.timeDependency,
    taskProfile: selectTaskProfile(input, executionLevel),
    confidence: input.confidence,
    assumptions,
    missingFields: input.missingFields,
    clarificationDecision: clarification.decision,
    clarificationValue: clarification.value,
    goalRequired: persistentRunRequired,
    persistentRunRequired,
    reasonCodes: reasonCodes(input, executionLevel, clarification.decision),
    routerVersion: 'awkn-intent-router/v1',
    routedAt: command.routedAt,
  });
}

export function buildIntentReceiptPayload(decision: IntentDecision): IntentReceiptPayload {
  const value = IntentDecisionSchema.parse(decision);
  return IntentReceiptPayloadSchema.parse({
    schema: 'awkn-intent-receipt/v1',
    intentId: value.intentId,
    inputId: value.inputId,
    level: value.executionLevel,
    taskProfile: value.taskProfile,
    externalSideEffects: value.externalSideEffects,
    clarification: value.clarificationDecision,
    clarificationValue: value.clarificationValue,
    goalRequired: value.goalRequired,
    reasonCodes: value.reasonCodes,
    routerVersion: value.routerVersion,
    createdAt: value.routedAt,
  });
}
