import { describe, expect, it } from 'vitest';
import { ownBranch, parseServerMessage } from '../src/index.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);
const part = (over: object) =>
  JSON.stringify({ type: 'tests.run', partId: '00000000-0000-4000-8000-000000000001', repo: { url: 'https://example.com/r.git', token: '' }, branch: 'task-1', task: 1, command: 'make test', part: 1, parts: 1, timeoutMs: 1000, ...over });

describe('the commit a part of a run is told to check', () => {
  it.each([SHA1, SHA256])('carries the full object name %s', sha => {
    expect(parseServerMessage(part({ commitSha: sha }))).toMatchObject({ commitSha: sha });
  });

  it.each(['abc1234', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(50), 'A'.repeat(40), `${'a'.repeat(39)}g`, 'main', ''])('refuses %j, which names no exact commit', sha => {
    expect(parseServerMessage(part({ commitSha: sha }))).toBeNull();
  });

  it.each([{}, { commitSha: null }])('still reads a part with no pinned commit: %j', over => {
    expect(parseServerMessage(part(over))).not.toBeNull();
  });
});

describe("a task's own branch", () => {
  it.each([
    { names: ['main', 'task-12'], want: { branch: 'task-12' } },
    { names: ['task-12', 'task-12-other'], want: { branch: 'task-12' } },
    { names: ['main', 'task-12-checkout', 'task-120-other'], want: { branch: 'task-12-checkout' } },
  ])('is found among $names', ({ names, want }) => {
    expect(ownBranch(names, 12)).toEqual(want);
  });

  it('is never guessed among several', () => {
    expect(ownBranch(['task-12-b', 'task-12-a'], 12)).toEqual({ problem: 'Several branches belong to task 12: task-12-a, task-12-b. Name the one to test.' });
  });

  it('is told apart from the branch of another task', () => {
    expect(ownBranch(['main', 'task-120-other'], 12)).toEqual({ problem: "The repository has no branch task-12 or task-12-... Push the task's branch, or name the branch to test." });
  });
});
