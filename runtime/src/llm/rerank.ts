import { cosineSimilarity, HashEmbeddingProvider, OllamaEmbeddingProvider, type EmbeddingProvider } from '../memory/embedding.js';

export interface RerankItem {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankInput {
  query: string;
  items: RerankItem[];
  topK?: number;
}

export interface RerankProvider {
  readonly name: string;
  rerank(input: RerankInput): Promise<RerankResult[]>;
}

export class NoopRerankProvider implements RerankProvider {
  readonly name = 'noop';

  async rerank(input: RerankInput): Promise<RerankResult[]> {
    return input.items.map((item, index) => ({
      id: item.id,
      score: Math.max(0, 1 - index / Math.max(1, input.items.length)),
    }));
  }
}

export class EmbeddingRerankProvider implements RerankProvider {
  readonly name = 'embedding';

  constructor(private readonly embedding: EmbeddingProvider) {}

  async rerank(input: RerankInput): Promise<RerankResult[]> {
    if (input.items.length === 0) return [];
    const topK = Math.min(input.topK ?? input.items.length, input.items.length);
    const batchSize = 32;
    const queryVector = await this.embedding.embed(input.query);
    const vectors: number[][] = [];
    for (let offset = 0; offset < input.items.length; offset += batchSize) {
      const chunk = input.items.slice(offset, offset + batchSize).map((item) => item.text);
      const chunkVectors = await this.embedding.embedMany(chunk);
      vectors.push(...chunkVectors);
    }
    const scored = input.items
      .map((item, index) => ({
        id: item.id,
        score: Math.max(0, cosineSimilarity(queryVector, vectors[index] ?? [])),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    return scored;
  }
}

export function createRerankProvider(embedding: EmbeddingProvider): RerankProvider {
  if (process.env.AWKN_RERANK_PROVIDER === 'embedding') return new EmbeddingRerankProvider(embedding);
  return new NoopRerankProvider();
}

export function createEmbeddingProvider(): EmbeddingProvider {
  if (process.env.AWKN_EMBEDDING_URL ?? process.env.AWKN_EMBEDDING_MODEL) {
    return new OllamaEmbeddingProvider();
  }
  return new HashEmbeddingProvider();
}
