/**
 * awkn-local-action-runner — Git 自动化
 *
 * 吸收 qoder-action src/git/ 的 5 个文件，本地化。
 * 只用 child_process 调 git 命令，不加依赖。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertGitWriteAuthorized } from './git-write-guard.js';

const execFileAsync = promisify(execFile);

export interface GitContext {
  repo: string;
  branch: string;
  sha: string;
  shortSha: string;
  isClean: boolean;
  recentCommits: Array<{ sha: string; message: string; author: string }>;
  changedFiles: string[];
}

/** 采集当前仓库上下文（对标 qoder-action git-context.ts） */
export async function getGitContext(cwd: string): Promise<GitContext> {
  const [repo, branch, sha, status, log, diff] = await Promise.all([
    git(cwd, 'remote', 'get-url', 'origin').catch(() => 'local'),
    git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(cwd, 'rev-parse', 'HEAD'),
    git(cwd, 'status', '--porcelain'),
    git(cwd, 'log', '--oneline', '-10', '--format=%H|%s|%an'),
    git(cwd, 'diff', '--name-only', 'HEAD~1').catch(() => ''),
  ]);

  return {
    repo: repo.trim(),
    branch: branch.trim(),
    sha: sha.trim(),
    shortSha: sha.trim().slice(0, 7),
    isClean: status.trim() === '',
    recentCommits: log.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('|');
      return { sha: parts[0] ?? '', message: parts[1] ?? '', author: parts[2] ?? '' };
    }),
    changedFiles: diff.trim().split('\n').filter(Boolean),
  };
}

/** 冻结候选分支（对标 qoder-action repo-setup.ts + branch-naming.ts）。写入需显式授权。 */
export async function freezeCandidate(cwd: string, releaseId: string): Promise<string> {
  assertGitWriteAuthorized('branch');
  assertGitWriteAuthorized('push');
  assertGitWriteAuthorized('tag');
  const branchName = `release/${releaseId}`;
  await git(cwd, 'checkout', '-b', branchName);
  await git(cwd, 'push', 'origin', branchName);
  await git(cwd, 'tag', `v${releaseId}`);
  await git(cwd, 'push', 'origin', `v${releaseId}`);
  return branchName;
}

/** 提交并推送（对标 qoder-action commit-and-push.ts）。写入需显式授权。 */
export async function commitAndPush(cwd: string, message: string): Promise<string> {
  assertGitWriteAuthorized('commit');
  assertGitWriteAuthorized('push');
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', message);
  await git(cwd, 'push');
  const sha = await git(cwd, 'rev-parse', 'HEAD');
  return sha.trim();
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 }).then((r) => r.stdout);
}
