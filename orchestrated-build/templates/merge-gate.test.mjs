import { describe, expect, it } from 'vitest';
import { problems } from './merge-gate.mjs';

const reviewed = `## What

A change.

## Review
- deslop: removed two narrating comments
- no-comments: nothing to remove
- ponytail-review: no findings
`;

const pr = (overrides = {}) => ({
  state: 'OPEN',
  isDraft: false,
  body: reviewed,
  statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }],
  ...overrides,
});

describe('merge gate', () => {
  it('lets an open, reviewed PR with green checks merge', () => {
    expect(problems(pr())).toEqual([]);
  });

  it('accepts commit statuses, which report state and context', () => {
    expect(problems(pr({ statusCheckRollup: [{ context: 'ci/legacy', state: 'SUCCESS' }] }))).toEqual([]);
  });

  it('refuses a review line left empty', () => {
    const body = reviewed.replace('- no-comments: nothing to remove', '- no-comments:');
    expect(problems(pr({ body }))).toEqual(['"## Review" has no filled "- no-comments:" line']);
  });

  it('refuses review lines outside the Review section', () => {
    const body = `## What\n- deslop: x\n- no-comments: x\n- ponytail-review: x\n\n## Review\n`;
    expect(problems(pr({ body }))).toHaveLength(3);
  });

  it('refuses a PR with no body', () => {
    expect(problems(pr({ body: null }))).toHaveLength(3);
  });

  it('refuses failing, pending and missing checks', () => {
    expect(problems(pr({ statusCheckRollup: [{ name: 'check', conclusion: 'FAILURE' }] }))).toEqual([
      'CI "check" is failure',
    ]);
    expect(problems(pr({ statusCheckRollup: [{ name: 'check', conclusion: null, state: 'PENDING' }] }))).toEqual([
      'CI "check" is pending',
    ]);
    expect(problems(pr({ statusCheckRollup: [] }))).toEqual(['no CI check ran on the head commit']);
  });

  it('refuses drafts and closed PRs', () => {
    expect(problems(pr({ isDraft: true }))).toEqual(['the PR is a draft']);
    expect(problems(pr({ state: 'MERGED' }))).toEqual(['the PR is merged']);
  });
});
