import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import {
  assertGitWriteAuthorized,
  GitWriteNotAuthorizedError,
  readGitWriteAuthorizationFile,
} from '../src/action/git-write-guard.js';
import { commitAndPush, freezeCandidate } from '../src/action/git-auto.js';

const tempDirs: string[] = [];

function authDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-write-guard-'));
  tempDirs.push(dir);
  return dir;
}

/** 在临时目录写入授权文件并设置环境变量指向它 */
function writeAuthFile(dir: string, payload: { expiresAt?: string; scope?: string[] }): string {
  const file = join(dir, 'git-write-auth.json');
  writeFileSync(file, JSON.stringify({
    issuedAt: new Date().toISOString(),
    expiresAt: payload.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    scope: payload.scope ?? ['commit', 'branch', 'tag', 'push'],
  }));
  process.env.AWKN_GIT_WRITE_AUTH_FILE = file;
  return file;
}

after(() => {
  delete process.env.AWKN_GIT_WRITE_AUTH;
  delete process.env.AWKN_GIT_WRITE_AUTH_FILE;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('git-write-guard — 外部写入显式授权门（P0-7）', () => {
  it('默认拒绝：无 env、无授权文件时所有写入动作被拒', () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    delete process.env.AWKN_GIT_WRITE_AUTH_FILE;
    assert.throws(() => assertGitWriteAuthorized('commit'), GitWriteNotAuthorizedError);
    assert.throws(() => assertGitWriteAuthorized('branch'), GitWriteNotAuthorizedError);
    assert.throws(() => assertGitWriteAuthorized('push'), GitWriteNotAuthorizedError);
  });

  it('AWKN_GIT_WRITE_AUTH=yes 显式放行', () => {
    process.env.AWKN_GIT_WRITE_AUTH = 'yes';
    delete process.env.AWKN_GIT_WRITE_AUTH_FILE;
    assert.doesNotThrow(() => assertGitWriteAuthorized('push'));
  });

  it('授权文件放行 scope 内动作', () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    writeAuthFile(authDir(), { scope: ['commit'] });
    assert.doesNotThrow(() => assertGitWriteAuthorized('commit'));
    assert.throws(() => assertGitWriteAuthorized('push'), GitWriteNotAuthorizedError);
  });

  it('授权文件过期后拒绝', () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    writeAuthFile(authDir(), { expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.throws(() => assertGitWriteAuthorized('commit'), /expired/);
  });

  it('损坏的授权文件视为未授权', () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    const dir = authDir();
    const file = join(dir, 'git-write-auth.json');
    writeFileSync(file, '{ not valid json');
    process.env.AWKN_GIT_WRITE_AUTH_FILE = file;
    assert.equal(readGitWriteAuthorizationFile(), null);
    assert.throws(() => assertGitWriteAuthorized('commit'), GitWriteNotAuthorizedError);
  });

  it('commitAndPush 未授权时拒绝且不执行 git 命令', async () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    delete process.env.AWKN_GIT_WRITE_AUTH_FILE;
    await assert.rejects(commitAndPush(tmpdir(), 'should not commit'), GitWriteNotAuthorizedError);
  });

  it('freezeCandidate 未授权时拒绝', async () => {
    delete process.env.AWKN_GIT_WRITE_AUTH;
    delete process.env.AWKN_GIT_WRITE_AUTH_FILE;
    await assert.rejects(freezeCandidate(tmpdir(), 'x'), GitWriteNotAuthorizedError);
  });

  it('授权后 commitAndPush 全链路真实执行（bare remote）', async () => {
    const root = authDir();
    const work = join(root, 'work');
    const bare = join(root, 'remote.git');
    mkdirSync(work);
    mkdirSync(bare);
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    execFileSync('git', ['init'], { cwd: work, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'guard@test.local'], { cwd: work });
    execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: work });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: work });
    writeFileSync(join(work, 'a.txt'), 'hello ' + randomUUID());
    execFileSync('git', ['add', '-A'], { cwd: work });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: work });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: work });
    execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: work });

    delete process.env.AWKN_GIT_WRITE_AUTH;
    writeAuthFile(root, { scope: ['commit', 'push'] });
    writeFileSync(join(work, 'a.txt'), 'guarded change ' + randomUUID());
    const sha = await commitAndPush(work, 'guarded commit');
    assert.ok(/^[0-9a-f]{40}$/.test(sha));
    const log = execFileSync('git', ['log', '--oneline', '-2'], { cwd: work, encoding: 'utf-8' });
    assert.ok(log.includes('guarded commit'));
  });
});
