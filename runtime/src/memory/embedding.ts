export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
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

  async embed(text: string): Promise<number[]> {
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

  async embedMany(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await this.embed(text));
    return vectors;
  }
}

export interface OllamaEmbeddingOptions {
  url?: string;
  model?: string;
  timeoutMs?: number;
  cacheSize?: number;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { vector: number[]; at: number }>();
  private readonly cacheSize: number;
  private resolvedDimensions = 0;
  private degraded = false;
  private lastError: unknown = null;

  constructor(options: OllamaEmbeddingOptions = {}) {
    this.url = (options.url ?? process.env.AWKN_EMBEDDING_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = options.model ?? process.env.AWKN_EMBEDDING_MODEL ?? 'nomic-embed-text';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cacheSize = options.cacheSize ?? 512;
    this.dimensions = 0;
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedMany([text]);
    return vectors[0] ?? [];
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      const key = this.cacheKey(text);
      if (!this.cache.has(key) && !seen.has(key)) {
        seen.add(key);
        unique.push(text);
      }
    }
    if (unique.length > 0) await this.fetchVectors(unique);
    return texts.map((text) => this.cache.get(this.cacheKey(text))?.vector ?? []);
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  lastFailure(): unknown {
    return this.lastError;
  }

  private cacheKey(text: string): string {
    return `${this.model}:${text}`;
  }

  private async fetchVectors(texts: string[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.url}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embedding http ${response.status}`);
      const body = (await response.json()) as { embeddings?: number[][] };
      const embeddings = body.embeddings ?? [];
      if (embeddings.length === 0) throw new Error('embedding empty response');
      const sample = embeddings[0] ?? [];
      if (sample.length === 0) throw new Error('embedding zero dimension');
      if (this.resolvedDimensions === 0) {
        this.resolvedDimensions = sample.length;
        (this as { dimensions: number }).dimensions = sample.length;
      } else if (sample.length !== this.resolvedDimensions) {
        throw new Error(`embedding dimension mismatch: ${sample.length} != ${this.resolvedDimensions}`);
      }
      const now = Date.now();
      texts.forEach((text, index) => {
        const vector = embeddings[index] ?? [];
        this.cache.set(this.cacheKey(text), { vector, at: now });
      });
      while (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.degraded = false;
      this.lastError = null;
    } catch (error) {
      this.degraded = true;
      this.lastError = error;
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
