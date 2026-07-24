import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictReviewVerdict } from '../../src/gates/review-verdict.js';

describe('strict review verdict', () => {
  it('accepts one explicit PASS line', () => {
    assert.equal(parseStrictReviewVerdict('VERDICT: PASS'), 'PASS');
  });

  it('accepts one explicit FAIL line with issues', () => {
    assert.equal(parseStrictReviewVerdict('VERDICT: FAIL\nISSUES:\n- test failed'), 'FAIL');
  });

  it('rejects vague language', () => {
    assert.equal(parseStrictReviewVerdict('看起来可以通过'), null);
  });

  it('rejects conflicting verdicts', () => {
    assert.equal(parseStrictReviewVerdict('VERDICT: PASS\nVERDICT: FAIL'), null);
  });
});
