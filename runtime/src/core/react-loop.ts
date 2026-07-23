/**
 * ReAct 状态机 — 从 awkn-agent 抽取（零依赖纯函数）
 *
 * 来源：awkn-agent/src/core/react-loop.ts
 * 改动：无（直接复用）
 */

export type ReActStep = 'THINK' | 'ACT' | 'OBSERVE' | 'REFLECT' | 'DONE';

export interface Observation {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
  ts: number;
}

export interface Reflection {
  step: ReActStep;
  shouldContinue: boolean;
  shouldRetry: boolean;
  suggestedNextAction?: string;
  reason: string;
  confidence: number;
}

export interface ReActState {
  conversationId: string;
  turn: number;
  step: ReActStep;
  history: Array<{ step: ReActStep; ts: number; note: string }>;
  observations: Observation[];
  reflections: Reflection[];
  totalObservations: number;
  totalErrors: number;
  consecutiveErrors: number;
  lastReflection?: Reflection;
}

const REFLECT_TRIGGER_ERRORS = 1;
const REFLECT_TRIGGER_OBSERVATIONS = 3;

export function createReActState(conversationId: string): ReActState {
  return {
    conversationId,
    turn: 0,
    step: 'THINK',
    history: [{ step: 'THINK', ts: Date.now(), note: 'turn start' }],
    observations: [],
    reflections: [],
    totalObservations: 0,
    totalErrors: 0,
    consecutiveErrors: 0,
  };
}

export function recordObservation(
  state: ReActState,
  obs: Omit<Observation, 'ts'>,
): ReActState {
  const fullObs: Observation = { ...obs, ts: Date.now() };
  const newState: ReActState = {
    ...state,
    observations: [...state.observations, fullObs],
    totalObservations: state.totalObservations + 1,
    step: 'OBSERVE',
    history: [
      ...state.history,
      {
        step: 'OBSERVE',
        ts: Date.now(),
        note: `${obs.toolName} ${obs.isError ? 'failed' : 'ok'}`,
      },
    ],
  };
  if (obs.isError) {
    newState.totalErrors++;
    newState.consecutiveErrors++;
  } else {
    newState.consecutiveErrors = 0;
  }
  return newState;
}

export function shouldReflect(state: ReActState): boolean {
  if (state.consecutiveErrors >= REFLECT_TRIGGER_ERRORS) return true;
  if (
    state.totalObservations > 0 &&
    state.totalObservations % REFLECT_TRIGGER_OBSERVATIONS === 0
  )
    return true;
  return false;
}

export function reflect(state: ReActState): ReActState {
  const lastObs = state.observations[state.observations.length - 1];
  if (!lastObs) {
    return {
      ...state,
      step: 'DONE',
      lastReflection: emptyReflection('DONE', 'no observation'),
    };
  }

  let reflection: Reflection;

  if (state.consecutiveErrors >= 2) {
    reflection = {
      step: 'DONE',
      shouldContinue: false,
      shouldRetry: false,
      reason: `Loop detected: ${state.consecutiveErrors} consecutive errors, last on ${lastObs.toolName}`,
      confidence: 0.95,
    };
  } else if (lastObs.isError) {
    const priorErrorsOnTool = state.observations
      .slice(0, -1)
      .filter((o) => o.isError && o.toolName === lastObs.toolName).length;
    const shouldGiveUpOnTool = priorErrorsOnTool >= 1;
    reflection = {
      step: shouldGiveUpOnTool ? 'DONE' : 'ACT',
      shouldContinue: !shouldGiveUpOnTool,
      shouldRetry: !shouldGiveUpOnTool,
      suggestedNextAction: shouldGiveUpOnTool
        ? `give up on ${lastObs.toolName} (already failed ${priorErrorsOnTool + 1} times) and try a different approach`
        : `retry ${lastObs.toolName} with adjusted params`,
      reason: `Tool ${lastObs.toolName} failed: ${lastObs.errorMessage?.slice(0, 100)}`,
      confidence: shouldGiveUpOnTool ? 0.25 : 0.6,
    };
  } else {
    reflection = {
      step: 'THINK',
      shouldContinue: true,
      shouldRetry: false,
      reason: `Tool ${lastObs.toolName} succeeded, ${state.totalObservations} total observations`,
      confidence: 0.8,
    };
  }

  return {
    ...state,
    step: reflection.step,
    reflections: [...state.reflections, reflection],
    lastReflection: reflection,
    history: [
      ...state.history,
      {
        step: 'REFLECT',
        ts: Date.now(),
        note: `${reflection.shouldContinue ? 'continue' : 'stop'} (conf=${reflection.confidence.toFixed(2)})`,
      },
    ],
  };
}

function emptyReflection(step: ReActStep, reason: string): Reflection {
  return {
    step,
    shouldContinue: false,
    shouldRetry: false,
    reason,
    confidence: 0,
  };
}

export function nextStep(
  state: ReActState,
  hasToolCall: boolean,
  llmProducedText: boolean,
): ReActStep {
  if (hasToolCall) return 'ACT';
  if (llmProducedText) return 'DONE';
  if (state.step === 'THINK') return 'THINK';
  return state.lastReflection?.step ?? 'DONE';
}

export function summarizeReAct(state: ReActState): string {
  const last = state.reflections[state.reflections.length - 1];
  const parts = [
    `turn=${state.turn}`,
    `step=${state.step}`,
    `obs=${state.totalObservations}`,
    `errors=${state.totalErrors} (consec=${state.consecutiveErrors})`,
  ];
  if (last) {
    parts.push(`lastReflection.confidence=${last.confidence.toFixed(2)}`);
  }
  return parts.join(' | ');
}
