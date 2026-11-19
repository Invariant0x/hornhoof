import { describe, expect, it } from 'vitest';
import { isNumbered, parseNodeMessage, parseServerMessage, type AuthorCheckRun } from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(40), hash = 'a'.repeat(64);
const request: AuthorCheckRun = {
  type: 'author_check.run', requestId: id,
  pin: { taskId: id, agentId: id, branch: 'task-1', baseCommit: sha, commit: 'b'.repeat(40), paths: ['docs/plan.md'], repoUrlHash: hash },
  mainCommit: sha, verifyCherryPick: false,
  repositoryScope: { companyId: id, repositoryOwnerId: id, repoUrlHash: hash },
  repo: { url: 'https://example.com/repo.git', token: '' },
};

describe('author-check node messages', () => {
  it('accepts a pinned request with no argument or result override', () => {
    expect(parseServerMessage(JSON.stringify(request))).toEqual(request);
    expect(parseServerMessage(JSON.stringify({ ...request, command: 'invalid' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...request, pin: { ...request.pin, paths: ['docs/../README.md'] } }))).toBeNull();
  });

  it('numbers the node completion and rejects an invalid score', () => {
    const result = { type: 'author_check.done', requestId: id, taskId: id, commit: sha, crap: 2, cherryPick: null, n: 1 };
    const parsed = parseNodeMessage(JSON.stringify(result));
    expect(parsed).toEqual(result);
    expect(parsed && isNumbered(parsed)).toBe(true);
    expect(parseNodeMessage(JSON.stringify({ ...result, crap: -1 }))).toBeNull();
  });
});
