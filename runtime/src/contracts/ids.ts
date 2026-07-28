import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const AWKN_ID_PREFIXES = {
  input: 'in',
  intent: 'intent',
  context: 'ctx',
  contextRender: 'rnd',
  execution: 'exec',
  trace: 'tr',
  goal: 'goal',
  run: 'run',
  step: 'step',
  claim: 'clm',
  evidence: 'ev',
  receipt: 'rcpt',
  authorization: 'auth',
  delivery: 'dlv',
  outcome: 'out',
  artifact: 'art',
  memoryTransaction: 'mtx',
  candidate: 'cand',
  event: 'evt',
  flagSnapshot: 'fsnap',
  shadowDiff: 'sdiff',
  brokerPlan: 'bp',
  modelRoute: 'mr',
  toolCall: 'tc',
  policyBundle: 'pb',
  skillBundle: 'sb',
  cycle: 'cyc',
  evidenceDelta: 'ed',
  strategyAttempt: 'sa',
} as const;

export type AwknIdKind = keyof typeof AWKN_ID_PREFIXES;
export type AwknIdPrefix = (typeof AWKN_ID_PREFIXES)[AwknIdKind];

const HEX_32 = '[0-9a-f]{32}';

export function awknIdSchema(prefix: AwknIdPrefix): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}_${HEX_32}$`), `invalid ${prefix} identifier`);
}

export const AnyAwknIdSchema = z.string().refine((value) =>
  Object.values(AWKN_ID_PREFIXES).some((prefix) => new RegExp(`^${prefix}_${HEX_32}$`).test(value)),
'invalid AWKN identifier');

export function createAwknId(kind: AwknIdKind): string {
  return `${AWKN_ID_PREFIXES[kind]}_${randomUUID().replaceAll('-', '').toLowerCase()}`;
}
