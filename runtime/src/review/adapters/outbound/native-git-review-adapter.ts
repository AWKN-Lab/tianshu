import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  REVIEW_SCOPE_SPEC_SCHEMA,
  ReviewScopeSpecSchema,
  type ReviewFile,
  type ReviewFileStatus,
  type ReviewPlan,
  type ReviewScopeSpec,
  type ReviewTarget,
} from '../../../contracts/public.js';
import type { ReviewScopeRequest, ReviewSpecProviderPort } from '../../ports/outbound/review-spec-provider-port.js';
import type {
  ReviewArtifactBundle,
  ReviewFileArtifact,
  ReviewWorkspacePort,
} from '../../ports/outbound/review-workspace-port.js';

const NATIVE_BASELINE_RULE_ID = 'native:awkn-review-baseline/v1';
const NATIVE_BASELINE_RULE = 'Review the frozen diff for correctness, contracts, regressions, test quality, and security. Report only evidence-backed findings.';

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string>;
}

class ExecFileGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
        shell: false,
      }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise(stdout);
      });
    });
  }
}

interface ChangedPath {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ReviewFileStatus;
  readonly untracked?: boolean;
}

interface GitSnapshot {
  readonly scope: ReviewScopeSpec;
  readonly artifacts: ReviewArtifactBundle;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function posixPath(value: string): string {
  const normalized = value.split(sep).join('/').replaceAll('\\', '/').normalize('NFC');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    || normalized.includes('\0')
  ) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  return normalized;
}

function statusFromCode(code: string): ReviewFileStatus {
  const normalized = code.toUpperCase();
  if (normalized.startsWith('R')) return 'RENAMED';
  if (normalized.startsWith('C')) return 'COPIED';
  if (normalized.includes('D')) return 'DELETED';
  if (normalized.includes('A') || normalized === '??') return 'ADDED';
  return 'MODIFIED';
}

function parseRangeNameStatus(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files: ChangedPath[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++] ?? '';
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[index++];
      const path = tokens[index++];
      if (oldPath === undefined || path === undefined) throw new Error('malformed git rename/copy output');
      files.push({ path: posixPath(path), oldPath: posixPath(oldPath), status: statusFromCode(code) });
    } else {
      const path = tokens[index++];
      if (path === undefined) throw new Error('malformed git name-status output');
      files.push({ path: posixPath(path), status: statusFromCode(code) });
    }
  }
  return files;
}

function parseWorktreeStatus(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files: ChangedPath[] = [];
  for (let index = 0; index < tokens.length;) {
    const entry = tokens[index++] ?? '';
    if (entry.length < 4) throw new Error('malformed git status output');
    const code = entry.slice(0, 2);
    const path = posixPath(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const oldPath = tokens[index++];
      if (oldPath === undefined) throw new Error('malformed git worktree rename/copy output');
      files.push({ path, oldPath: posixPath(oldPath), status: statusFromCode(code) });
    } else {
      files.push({ path, status: statusFromCode(code), ...(code === '??' ? { untracked: true } : {}) });
    }
  }
  return files;
}

function patchStats(patch: string): { insertions: number; deletions: number; binary: boolean } {
  const binary = /(^|\n)(GIT binary patch|Binary files )/.test(patch);
  if (binary) return { insertions: 0, deletions: 0, binary: true };
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) insertions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { insertions, deletions, binary: false };
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function matches(path: string, patterns: readonly string[] | undefined): boolean {
  return patterns !== undefined && patterns.some((pattern) => globRegex(pattern).test(path));
}

function isGenerated(path: string): boolean {
  return /(^|\/)(dist|build|coverage|vendor|node_modules)(\/|$)|\.min\.[^/]+$/i.test(path);
}

function untrackedPatch(path: string, bytes: Uint8Array): { patch: string; binary: boolean } {
  if (bytes.includes(0)) return { patch: 'GIT binary patch\n', binary: true };
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  const lines = content.split('\n');
  const body = lines.map((line) => `+${line}`).join('\n');
  return {
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
    binary: false,
  };
}

function fileFingerprint(file: ChangedPath, patch: string, stats: ReturnType<typeof patchStats>): string {
  return sha256(JSON.stringify({
    old_path: file.oldPath ?? null,
    path: file.path,
    status: file.status.toLowerCase(),
    insertions: stats.insertions,
    deletions: stats.deletions,
    binary: stats.binary,
    diff: patch,
  }));
}

function aggregateFingerprint(
  fromOid: string,
  toOid: string,
  mergeBase: string,
  files: readonly ReviewFile[],
): string {
  return sha256(JSON.stringify({
    from_oid: fromOid,
    to_oid: toOid,
    merge_base_oid: mergeBase,
    files: files.map((file) => ({ path: file.path, diff_fingerprint: `sha256:${file.diffFingerprint}` })),
  }));
}

export class NativeGitReviewAdapter implements ReviewSpecProviderPort, ReviewWorkspacePort {
  readonly provider = 'native-git' as const;
  private readonly runner: GitCommandRunner;

  constructor(runner?: GitCommandRunner) {
    this.runner = runner ?? new ExecFileGitCommandRunner();
  }

  async createScope(request: ReviewScopeRequest): Promise<ReviewScopeSpec> {
    return (await this.snapshot(request)).scope;
  }

  async freeze(target: ReviewTarget): Promise<ReviewArtifactBundle> {
    return (await this.snapshot({
      repositoryRoot: target.repositoryRoot,
      mode: target.mode,
      baseRef: target.baseRef,
      headRef: target.headRef,
      includePatterns: target.includePatterns,
      excludePatterns: target.excludePatterns,
    })).artifacts;
  }

  async currentFingerprint(plan: ReviewPlan): Promise<string> {
    const scope = await this.createScope({
      repositoryRoot: plan.target.repositoryRoot,
      mode: plan.target.mode,
      baseRef: plan.target.baseRef,
      headRef: plan.target.headRef,
      includePatterns: plan.target.includePatterns,
      excludePatterns: plan.target.excludePatterns,
    });
    return scope.diffFingerprint;
  }

  private async snapshot(request: ReviewScopeRequest): Promise<GitSnapshot> {
    if (!isAbsolute(request.repositoryRoot)) throw new Error('repositoryRoot must be absolute');
    const root = resolve(request.repositoryRoot);
    const realRoot = await realpath(root);
    const topLevel = resolve((await this.runner.run(root, ['rev-parse', '--show-toplevel'])).trim());
    const realTopLevel = await realpath(topLevel);
    if (realTopLevel.toLowerCase() !== realRoot.toLowerCase()) {
      throw new Error(`repositoryRoot must be Git top-level: ${topLevel}`);
    }

    let fromOid: string;
    let toOid: string;
    let mergeBase: string;
    let changed: ChangedPath[];
    if (request.mode === 'COMMIT_RANGE') {
      if (request.baseRef === undefined || request.headRef === undefined) {
        throw new Error('COMMIT_RANGE requires baseRef and headRef');
      }
      fromOid = (await this.runner.run(root, ['rev-parse', '--verify', '--end-of-options', `${request.baseRef}^{commit}`])).trim();
      toOid = (await this.runner.run(root, ['rev-parse', '--verify', '--end-of-options', `${request.headRef}^{commit}`])).trim();
      mergeBase = (await this.runner.run(root, ['merge-base', fromOid, toOid])).trim();
      if (mergeBase.length === 0) throw new Error('commit range has no merge-base');
      changed = parseRangeNameStatus(await this.runner.run(root, [
        'diff', '--name-status', '-z', '-M', '-C', mergeBase, toOid,
      ]));
    } else {
      fromOid = (await this.runner.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      toOid = 'WORKTREE';
      mergeBase = fromOid;
      changed = parseWorktreeStatus(await this.runner.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    }

    const reviewFiles: ReviewFile[] = [];
    const artifacts: ReviewFileArtifact[] = [];
    for (const item of changed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      let patch: string;
      let binaryFromRead = false;
      if (item.untracked === true) {
        const absolute = resolve(root, ...item.path.split('/'));
        const rel = relative(root, absolute);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes repository: ${item.path}`);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`untracked symbolic links are not reviewable: ${item.path}`);
        if (!stat.isFile()) throw new Error(`untracked non-regular files are not reviewable: ${item.path}`);
        const realAbsolute = await realpath(absolute);
        const realRel = relative(realRoot, realAbsolute);
        if (realRel.startsWith('..') || isAbsolute(realRel)) {
          throw new Error(`untracked path resolves outside repository: ${item.path}`);
        }
        const generated = untrackedPatch(item.path, await readFile(realAbsolute));
        patch = generated.patch;
        binaryFromRead = generated.binary;
      } else {
        const range = request.mode === 'COMMIT_RANGE' ? [mergeBase, toOid] : ['HEAD'];
        patch = await this.runner.run(root, ['diff', '--binary', '--no-ext-diff', ...range, '--', item.path]);
      }
      const detected = patchStats(patch);
      const stats = { ...detected, binary: detected.binary || binaryFromRead };
      const fingerprint = fileFingerprint(item, patch, stats);
      const excludedByUser = matches(item.path, request.excludePatterns)
        || (request.includePatterns !== undefined && request.includePatterns.length > 0 && !matches(item.path, request.includePatterns));
      const generated = isGenerated(item.path);
      const willReview = !stats.binary && !excludedByUser && !generated;
      reviewFiles.push({
        path: item.path,
        ...(item.oldPath === undefined ? {} : { oldPath: item.oldPath }),
        status: stats.binary ? 'BINARY' : item.status,
        insertions: stats.insertions,
        deletions: stats.deletions,
        diffFingerprint: fingerprint,
        willReview,
        ...(willReview ? {} : { excludeReason: stats.binary ? 'BINARY' : excludedByUser ? 'USER_EXCLUDED' : 'GENERATED' }),
        ruleGroupIds: [NATIVE_BASELINE_RULE_ID],
      });
      artifacts.push({ path: item.path, patch, diffFingerprint: fingerprint });
    }

    const diffFingerprint = aggregateFingerprint(fromOid, toOid, mergeBase, reviewFiles);
    const scope = ReviewScopeSpecSchema.parse({
      schema: REVIEW_SCOPE_SPEC_SCHEMA,
      provider: 'native-git',
      providerVersion: 'native-git/v1',
      repositoryRoot: root,
      baseRef: fromOid,
      headRef: toOid,
      mergeBase,
      diffFingerprint,
      files: reviewFiles,
      ruleGroups: [{
        ruleGroupId: NATIVE_BASELINE_RULE_ID,
        source: 'awkn-runtime',
        pattern: '**',
        contentHash: createHash('sha256').update(NATIVE_BASELINE_RULE).digest('hex'),
        text: NATIVE_BASELINE_RULE,
        files: reviewFiles.map((file) => file.path),
      }],
    });
    return {
      scope,
      artifacts: { targetFingerprint: diffFingerprint, files: artifacts },
    };
  }
}
