/**
 * Artifact Builder Port — 制品构建端口
 *
 * Spiral 3: Release Agent 通过此端口构建制品。端口实现可以是本地构建器、
 * 远程 CI 构建器或 mock。Release Agent 不直接构建制品，仅通过端口调用。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */

export interface ArtifactBuildInput {
  readonly sourceSha: string;
  readonly workItemId: string;
}

export interface BuiltArtifact {
  readonly artifactType: string;
  readonly artifactPath: string;
  readonly artifactDigest: string;
  readonly artifactSizeBytes: number;
}

export interface ArtifactBuildResult {
  readonly artifactDigest: string;
  readonly artifacts: readonly BuiltArtifact[];
}

/**
 * Artifact Builder Port — 构建制品并返回制品摘要与清单。
 *
 * 实现方负责实际的构建过程（编译、打包等）。Release Agent 仅消费结果。
 */
export interface ArtifactBuilderPort {
  readonly builderId: string;
  build(input: ArtifactBuildInput): Promise<ArtifactBuildResult>;
}
