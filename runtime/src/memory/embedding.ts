export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): number[];
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((token) => token.length > 1)
    .slice(0, 4000);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 128) {}

  embed(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const frequencies = new Map<string, number>();
    for (const token of tokenize(text)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [token, frequency] of frequencies) {
      const hash = fnv1a(token);
      const index = hash % this.dimensions;
      const sign = (hash & 0x80000000) === 0 ? 1 : -1;
      vector[index]! += sign * (1 + Math.log(frequency));
    }
    return normalize(vector);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function lexicalSimilarity(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  let overlap = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) overlap++;
  return overlap / queryTokens.size;
}
