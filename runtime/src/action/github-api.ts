/**
 * awkn-local-action-runner — GitHub API 交互（免费部分）
 *
 * 只用 gh CLI，不用 GitHub Actions。
 * 对标 qoder-action reporting/github-reporter.ts。
 * 所有操作 fail-open：gh 未安装或失败只 warn，不阻断 Pipeline。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('GitHubApi');

/** 在 PR 上发评论（免费） */
export async function postPRComment(cwd: string, prNumber: number, body: string): Promise<boolean> {
  try {
    await execFileAsync('gh', ['pr', 'comment', String(prNumber), '--body', body], {
      cwd,
      timeout: 30_000,
    });
    return true;
  } catch (err) {
    logger.warn(`gh pr comment failed: ${String(err)}`);
    return false;
  }
}

/** 设置 commit status check（免费） */
export async function setStatusCheck(
  cwd: string,
  sha: string,
  state: 'success' | 'failure',
  context: string,
  description: string,
): Promise<boolean> {
  try {
    // 从 git remote 解析 owner/repo
    const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd,
      timeout: 15_000,
    });
    const repo = stdout.trim();
    await execFileAsync('gh', [
      'api', `repos/${repo}/statuses/${sha}`,
      '-f', `state=${state}`,
      '-f', `context=${context}`,
      '-f', `description=${description.slice(0, 140)}`,
    ], { cwd, timeout: 15_000 });
    return true;
  } catch (err) {
    logger.warn(`gh status check failed: ${String(err)}`);
    return false;
  }
}

/** 创建 PR（免费，可选） */
export async function createPR(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create', '--title', title, '--body', body, '--base', base, '--head', head,
    ], { cwd, timeout: 30_000 });
    return stdout.trim();
  } catch (err) {
    logger.warn(`gh pr create failed: ${String(err)}`);
    return null;
  }
}
