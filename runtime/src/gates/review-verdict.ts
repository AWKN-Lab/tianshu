export type StrictReviewVerdict = 'PASS' | 'FAIL';

/**
 * Parse only explicit VERDICT lines. If a response contains conflicting verdicts,
 * treat it as invalid and fail closed.
 */
export function parseStrictReviewVerdict(text: string): StrictReviewVerdict | null {
  const matches = [...text.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/gim)]
    .map((match) => match[1]!.toUpperCase() as StrictReviewVerdict);
  const unique = new Set(matches);
  return unique.size === 1 ? matches[0] ?? null : null;
}
