/**
 * awkn-local-action-runner — Git 外部写入显式授权门（技能吸收 P0-7）
 *
 * 原则：默认拒绝（deny-by-default）。commit / branch / tag / push 这类外部
 * 可见写入必须显式授权，杜绝自主提交、自主建分支、自主推送。
 *
 * 授权来源（任一即可放行）：
 * 1. 环境变量 AWKN_GIT_WRITE_AUTH=yes —— 进程级显式开关（CI/本地显式设置）；
 * 2. 授权文件 data/git-write-auth.json —— 带有效期与 scope 的显式授权：
 *    { "issuedAt": ISO, "expiresAt": ISO, "scope": ["commit","branch","tag","push"] }
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type GitWriteAction = 'commit' | 'branch' | 'tag' | 'push';

export const GIT_WRITE_ACTIONS: readonly GitWriteAction[] = ['commit', 'branch', 'tag', 'push'];

export interface GitWriteAuthorizationFile {
  issuedAt: string;
  expiresAt: string;
  scope: GitWriteAction[];
}

export class GitWriteNotAuthorizedError extends Error {
  readonly action: GitWriteAction;
  constructor(action: GitWriteAction, reason: string) {
    super(`git write action "${action}" denied: ${reason}`);
    this.name = 'GitWriteNotAuthorizedError';
    this.action = action;
  }
}

/** 授权文件路径：默认 data/git-write-auth.json，可用 AWKN_GIT_WRITE_AUTH_FILE 覆盖 */
export function gitWriteAuthFilePath(): string {
  return process.env.AWKN_GIT_WRITE_AUTH_FILE
    ?? resolve(__dirname, '..', '..', 'data', 'git-write-auth.json');
}

/** 读取授权文件；缺失或损坏视为未授权 */
export function readGitWriteAuthorizationFile(): GitWriteAuthorizationFile | null {
  const filePath = gitWriteAuthFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<GitWriteAuthorizationFile>;
    if (typeof raw.issuedAt !== 'string' || typeof raw.expiresAt !== 'string' || !Array.isArray(raw.scope)) {
      return null;
    }
    return { issuedAt: raw.issuedAt, expiresAt: raw.expiresAt, scope: raw.scope };
  } catch {
    return null;
  }
}

/**
 * 检查某写入动作是否已获显式授权；未授权抛出 GitWriteNotAuthorizedError。
 * 已过期、scope 不含该动作、授权文件损坏均视为拒绝。
 */
export function assertGitWriteAuthorized(action: GitWriteAction): void {
  if (process.env.AWKN_GIT_WRITE_AUTH === 'yes') return;

  const auth = readGitWriteAuthorizationFile();
  if (!auth) {
    throw new GitWriteNotAuthorizedError(
      action,
      'no explicit authorization. Set AWKN_GIT_WRITE_AUTH=yes or create data/git-write-auth.json '
      + 'with a valid scope and expiresAt (default is deny).',
    );
  }
  if (new Date(auth.expiresAt).getTime() <= Date.now()) {
    throw new GitWriteNotAuthorizedError(action, `authorization expired at ${auth.expiresAt}`);
  }
  if (!auth.scope.includes(action)) {
    throw new GitWriteNotAuthorizedError(
      action,
      `not covered by authorization scope [${auth.scope.join(', ')}]`,
    );
  }
}
