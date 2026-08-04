import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/store/db.js';
import { EventStore } from '../src/workflow/event-store.js';
import { globToRegExp } from '../src/adapter/review-kernel-runner.js';
import { isTestPath, unitChannel } from '../src/review/application/review-service.js';

before(() => {
  process.env.AWKN_DB_PATH = join(mkdtempSync(join(tmpdir(), 'dual-channel-')), 'test.db');
  closeDb();
  getDb();
});

after(() => {
  delete process.env.AWKN_DB_PATH;
  closeDb();
});

// ─── 双通道：测试路径识别与路由 ───────────────────────────────────

describe('dual-channel unitChannel routing', () => {
  it('isTestPath 识别测试文件与测试目录', () => {
    assert.equal(isTestPath('src/foo.ts'), false);
    assert.equal(isTestPath('test/foo.test.ts'), true);
    assert.equal(isTestPath('src/foo.test.ts'), true);
    assert.equal(isTestPath('test/contracts/memory-backend-adapter.test.ts'), true);
    assert.equal(isTestPath('test/helpers/util.ts'), true);
  });

  it('TEST_ABUSE 恒为 test 通道', () => {
    assert.equal(unitChannel({ unitId: 'u1', type: 'TEST_ABUSE', paths: ['src/foo.ts'], reason: 'r' }), 'test');
  });

  it('CROSS_FILE 含测试路径路由到 test，否则 code', () => {
    const cross = (paths: string[]) => ({ unitId: 'u1', type: 'CROSS_FILE' as const, paths, reason: 'r' });
    assert.equal(unitChannel(cross(['test/a.test.ts', 'src/a.ts'])), 'test');
    assert.equal(unitChannel(cross(['src/a.ts'])), 'code');
  });

  it('实现/契约类单元路由到 code', () => {
    assert.equal(
      unitChannel({ unitId: 'u1', type: 'FILE', paths: ['src/adapter/review-kernel-runner.ts'], reason: 'r' }),
      'code',
    );
    assert.equal(
      unitChannel({ unitId: 'u2', type: 'SPEC', paths: ['docs/spec.md'], reason: 'r' }),
      'code',
    );
  });
});

// ─── 路径过滤 glob 语义 ────────────────────────────────────────────

describe('globToRegExp scope filters', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/*.test.ts', 'test/dual-channel-filter.test.ts', true],
    ['**/*.test.ts', 'src/cli.ts', false],
    ['src/**', 'src/cli.ts', true],
    ['src/**', 'test/a.test.ts', false],
    ['**/review-kernel-runner.ts', 'src/adapter/review-kernel-runner.ts', true],
    ['*', 'src/cli.ts', false],
    ['**', 'anything/at/all.ts', true],
    ['src/foo.ts', 'src/foo.ts', true],
    ['src/foo.ts', 'src/foo2.ts', false],
    ['test/?a.ts', 'test/aa.ts', true],
    ['test/?a.ts', 'test/aaa.ts', false],
  ];
  for (const [glob, path, expected] of cases) {
    it(`${glob} → ${path} = ${expected}`, () => {
      assert.equal(globToRegExp(glob).test(path), expected);
    });
  }
});

// ─── 事件订阅游标（stream-json 依赖） ──────────────────────────────

describe('event-store poll cursor', () => {
  it('lastEventId 无事件为 0，追加后递增', () => {
    const es = new EventStore();
    const run = es.createRun({ workflowName: 'wf', payload: { note: 'poll' } });
    const base = es.lastEventId();
    const id1 = es.appendEvent(run.id, 'run.created', { note: 'a' });
    const id2 = es.appendEvent(run.id, 'step.created', { note: 'b' });
    assert.ok(id2 > id1);
    assert.ok(es.lastEventId() >= id2);
    assert.equal(es.pollEventsAfter(base).length, 2);
  });

  it('pollEventsAfter 只返回游标之后的事件并按 id 升序', () => {
    const es = new EventStore();
    const run = es.createRun({ workflowName: 'wf', payload: { note: 'poll' } });
    const cursor = es.lastEventId();
    es.appendEvent(run.id, 'run.created', { seq: 1 });
    es.appendEvent(run.id, 'step.created', { seq: 2 });
    const events = es.pollEventsAfter(cursor);
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'run.created');
    assert.equal(events[1].event_type, 'step.created');
    assert.deepEqual(es.pollEventsAfter(events[1].id), []);
    assert.equal(es.pollEventsAfter(cursor, 1).length, 1);
  });
});

// ─── CLI review 命令行为 ───────────────────────────────────────────

describe('cli review command', () => {
  const cli = join(process.cwd(), 'src', 'cli.ts');

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWKN_DISABLE_EVOLVE: '1',
        AWKN_SKIP_ENV_FILE: '1',
        AWKN_DB_PATH: join(mkdtempSync(join(tmpdir(), 'cli-review-')), 'test.db'),
        AWKN_SKILLS_ROOT: join(process.cwd(), '..', 'skills'),
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('缺子命令时打印用法并退出 1', () => {
    const r = runCli(['review']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /review run --repo/);
  });

  it('--base 与 --head 必须成对提供', () => {
    const r = runCli(['review', 'run', '--repo', process.cwd(), '--base', 'HEAD']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--base 与 --head 必须成对提供/);
  });

  it('不支持的 --output-format 报错', () => {
    const r = runCli(['review', 'run', '--output-format', 'xml']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不支持的 --output-format/);
  });

  it('提交范围审核缺 OCR pins 时提示环境变量', () => {
    const r = runCli(['review', 'run', '--repo', process.cwd(), '--base', 'HEAD~1', '--head', 'HEAD']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AWKN_REVIEW_OCR_VERSION/);
  });
});
