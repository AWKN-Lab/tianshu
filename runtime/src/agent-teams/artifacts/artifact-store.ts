/**
 * AgentTeams — M4.1 artifact-store（C4 ArtifactBus 工件落盘/读取）
 *
 * 影响层级 [M]：Worker 间文件工件交换降 token（对齐 AgentTeams"共享文件降 token"思想）。
 * 布局：runtime/data/team-artifacts/<mission>/<workerId>/<file>
 * 隔离：下游只读上游工件路径（由 team-loop 传入），store 不提供跨 mission 遍历。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

function defaultArtifactsRoot(): string {
  if (process.env.AWKN_TEAM_ARTIFACTS_ROOT) return resolve(process.env.AWKN_TEAM_ARTIFACTS_ROOT);
  const here = dirname(fileURLToPath(import.meta.url));
  // src/agent-teams/artifacts → runtime
  const runtimeRoot = resolve(here, '..', '..', '..');
  return join(runtimeRoot, 'data', 'team-artifacts');
}

/** 使命名安全化（防路径穿越） */
export function sanitizeMissionName(mission: string): string {
  const base = mission
    .replace(/[\\/:*?"<>|\.\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || 'mission';
}

export class ArtifactStore {
  constructor(private readonly root: string = defaultArtifactsRoot()) {}

  /** mission 工件根目录 */
  missionDir(mission: string): string {
    return join(this.root, sanitizeMissionName(mission));
  }

  /** Worker 工件目录（自动创建） */
  workerDir(mission: string, workerId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(workerId)) {
      throw new Error(`[artifact-store] 非法 workerId：${workerId}`);
    }
    const dir = join(this.missionDir(mission), workerId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 写工件（文件内容） */
  write(mission: string, workerId: string, fileName: string, content: string): string {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      throw new Error(`[artifact-store] 非法文件名：${fileName}`);
    }
    const path = join(this.workerDir(mission, workerId), fileName);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  /** 读工件（绝对路径；下游只读所需） */
  read(artifactPath: string): string {
    return readFileSync(artifactPath, 'utf-8');
  }

  /** 列某 Worker 的工件文件（绝对路径） */
  listWorkerArtifacts(mission: string, workerId: string): string[] {
    const dir = join(this.missionDir(mission), workerId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile());
  }

  /** 取某 Worker 主工件（output.md 优先，否则首个文件） */
  primaryArtifact(mission: string, workerId: string): string | null {
    const files = this.listWorkerArtifacts(mission, workerId);
    if (files.length === 0) return null;
    return files.find((f) => basename(f) === 'output.md') ?? files[0]!;
  }
}

let singleton: ArtifactStore | null = null;

export function getArtifactStore(): ArtifactStore {
  if (!singleton) singleton = new ArtifactStore();
  return singleton;
}
