import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactText, type RedactionPattern } from '../src/core/redaction.js';

describe('redactText — 日志脱敏（P0-1）', () => {
  it('脱敏 GitHub Token 前缀', () => {
    const out = redactText('token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv');
    assert.ok(!out.includes('ghp_'));
    assert.ok(out.includes('[REDACTED:github-token]'));
  });

  it('脱敏 github_pat_ Token', () => {
    const out = redactText('PAT: github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef');
    assert.ok(!out.includes('github_pat_1234567890'));
    assert.ok(out.includes('[REDACTED:github-token]'));
  });

  it('脱敏 API Key 前缀（sk- / xox / AKIA / AIza）', () => {
    const cases = [
      'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz',
    ];
    for (const secret of cases) {
      const out = redactText(`value=${secret}`);
      assert.ok(!out.includes(secret), `should redact ${secret}`);
    }
  });

  it('脱敏 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactText(`Authorization: ${jwt}`);
    assert.ok(!out.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
    assert.ok(out.includes('[REDACTED:jwt]'));
  });

  it('脱敏凭据赋值（= 与 : 两种分隔，保留键名）', () => {
    const samples = [
      'export PASSWORD=SuperSecret123',
      'DB_PASSWORD: "hunter2"',
      "client_secret = 'a1b2c3'",
      'apikey=AbCdEfGhIjKlMnOpQrStUvWxYz',
      'connection_string=mongodb://user:hunter2@db.internal:27017/app',
    ];
    for (const line of samples) {
      const out = redactText(line);
      assert.ok(!/(hunter2|SuperSecret123|a1b2c3|AbCdEfGhIjKlMnOpQrStUvWxYz)/.test(out), `should redact value in: ${line}`);
      assert.ok(!/mongodb:\/\/user:hunter2/.test(out));
      assert.ok(out.includes('[REDACTED:credential-assignment]'), `placeholder in: ${line}`);
    }
  });

  it('脱敏 URL 连接串密码（保留用户名与协议）', () => {
    const out = redactText('postgres://app:SuperSecret@db.example:5432/mydb');
    assert.ok(!out.includes('SuperSecret'));
    assert.ok(out.includes('postgres://app:'));
    assert.ok(out.includes('[REDACTED:url-credentials]'));
    assert.ok(out.includes('@db.example:5432/mydb'));
  });

  it('脱敏 Bearer 头', () => {
    const out = redactText('curl -H "Authorization: Bearer abcdef0123456789abcdef0123456789"');
    assert.ok(!out.includes('abcdef0123456789abcdef0123456789'));
    assert.ok(out.includes('[REDACTED:bearer-token]'));
  });

  it('pwd: 命令输出不被误伤（仅脱敏 = 赋值形式的密码变量）', () => {
    const out = redactText('cwd: D:\\repo\npwd: /home/user\nMYSQL_PWD=hunter2');
    assert.ok(out.includes('pwd: /home/user'), 'pwd: 命令输出应保留');
    assert.ok(!out.includes('hunter2'));
    assert.ok(out.includes('[REDACTED:pwd-variable]'));
  });

  it('脱敏私钥块', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----';
    const out = redactText(`key:\n${key}`);
    assert.ok(!out.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj'));
    assert.ok(out.includes('[REDACTED:private-key]'));
  });

  it('普通文本不受影响', () => {
    const text = 'All 42 tests passed in 3.2s\ndeploy.sh started\nsummary: 12 files changed';
    assert.equal(redactText(text), text);
  });

  it('token 计数类普通文本不受影响', () => {
    const text = 'tokens: 12345';
    assert.equal(redactText(text), text);
  });

  it('空字符串原样返回', () => {
    assert.equal(redactText(''), '');
  });

  it('支持注入自定义模式', () => {
    const custom: RedactionPattern = {
      name: 'custom-secret',
      regex: /CUSTOM_[A-Z0-9]{8,}/g,
    };
    const out = redactText('CUSTOM_ABCDEF123', [custom]);
    assert.ok(!out.includes('ABCDEF123'));
    assert.ok(out.includes('[REDACTED:custom-secret]'));
  });

  it('非全局正则被忽略（防部分替换）', () => {
    const custom: RedactionPattern = {
      name: 'no-global',
      regex: /SECRET([0-9]+)/,
    };
    assert.equal(redactText('SECRET1 SECRET2', [custom]), 'SECRET1 SECRET2');
  });

  it('脱敏幂等：再次执行不改变结果', () => {
    const dirty = 'export PASSWORD=hunter2\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv';
    const once = redactText(dirty);
    assert.equal(redactText(once), once);
  });
});
