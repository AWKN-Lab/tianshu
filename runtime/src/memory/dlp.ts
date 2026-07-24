const BLOCK_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { name: 'seed-phrase', pattern: /\b(?:seed phrase|mnemonic)\s*[:=]\s*(?:[a-z]+\s+){11,23}[a-z]+\b/i },
];

const REDACT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github-token', pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

const SENSITIVE_KEYS = /(?:^|_)(?:api_?key|access_?token|auth_?token|password|secret|private_?key|session_?token)$/i;

export type MemoryDlpStatus = 'ALLOW' | 'REDACTED' | 'BLOCKED';

export interface MemoryDlpDecision<T> {
  status: MemoryDlpStatus;
  value: T;
  reasons: string[];
}

export class MemoryDlpBlockedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`memory persistence blocked: ${reasons.join(', ')}`);
    this.name = 'MemoryDlpBlockedError';
  }
}

function inspectString(value: string): MemoryDlpDecision<string> {
  const blocked = BLOCK_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(({ name }) => name);
  if (blocked.length > 0) return { status: 'BLOCKED', value, reasons: blocked };

  let redacted = value;
  const reasons: string[] = [];
  for (const { name, pattern } of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(redacted)) {
      reasons.push(name);
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, `[REDACTED:${name}]`);
    }
  }
  return { status: reasons.length > 0 ? 'REDACTED' : 'ALLOW', value: redacted, reasons };
}

function inspectUnknown(value: unknown, key?: string): MemoryDlpDecision<unknown> {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.test(key) && value.trim()) {
      return { status: 'REDACTED', value: '[REDACTED:sensitive-field]', reasons: [`sensitive-field:${key}`] };
    }
    return inspectString(value);
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const reasons: string[] = [];
    let status: MemoryDlpStatus = 'ALLOW';
    for (const item of value) {
      const decision = inspectUnknown(item);
      if (decision.status === 'BLOCKED') return { status: 'BLOCKED', value, reasons: decision.reasons };
      if (decision.status === 'REDACTED') status = 'REDACTED';
      output.push(decision.value);
      reasons.push(...decision.reasons);
    }
    return { status, value: output, reasons: [...new Set(reasons)] };
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const reasons: string[] = [];
    let status: MemoryDlpStatus = 'ALLOW';
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const decision = inspectUnknown(entryValue, entryKey);
      if (decision.status === 'BLOCKED') return { status: 'BLOCKED', value, reasons: decision.reasons };
      if (decision.status === 'REDACTED') status = 'REDACTED';
      output[entryKey] = decision.value;
      reasons.push(...decision.reasons);
    }
    return { status, value: output, reasons: [...new Set(reasons)] };
  }
  return { status: 'ALLOW', value, reasons: [] };
}

export function inspectMemoryPayload<T>(value: T): MemoryDlpDecision<T> {
  return inspectUnknown(value) as MemoryDlpDecision<T>;
}

export function guardMemoryPayload<T>(value: T): MemoryDlpDecision<T> {
  const decision = inspectMemoryPayload(value);
  if (decision.status === 'BLOCKED') throw new MemoryDlpBlockedError(decision.reasons);
  return decision;
}
