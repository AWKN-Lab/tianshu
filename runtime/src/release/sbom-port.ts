/**
 * SBOM Port — 软件物料清单生成端口
 *
 * Spiral 3: Release Agent 通过此端口为制品生成 SBOM。端口实现可以是
 * Syft、CycloneDX 工具或 mock。Release Agent 仅消费结果。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import type { BuiltArtifact } from './artifact-builder-port.js';

export interface SbomInput {
  readonly sourceSha: string;
  readonly artifacts: readonly BuiltArtifact[];
}

export interface SbomResult {
  readonly sbomDigest: string;
  readonly sbomContent: string;
}

/**
 * SBOM Port — 为给定源码 SHA 与制品清单生成 SBOM 并返回摘要。
 *
 * 实现方负责实际的 SBOM 生成过程。Release Agent 仅消费结果。
 */
export interface SbomPort {
  readonly generatorId: string;
  generate(input: SbomInput): Promise<SbomResult>;
}
