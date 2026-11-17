import { describe, expect, it } from 'vitest';
import { isNumbered, parseNodeMessage, parseServerMessage } from '../src/index.js';
import { authorCheckDocuments, sameAuthorCheck, AuthorCheckRequest } from '../src/author-check.js';

const id = '11111111-1111-4111-8111-111111111111';
const request = { type: 'author_check.run', requestId: id, jobId: id, agentId: id, taskId: id,
  repoUrl: 'https://github.com/acme/shop.git', branch: 'task-1', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), paths: ['logic/totals.ts'] };
const done = { ...request, type: 'author_check.done', exitCode: 0, crap: { kind: 'measured', max: 2 },
  startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:01.000Z', reason: null };

describe('node-owned author check messages', () => {
  it.each(['README.md', 'guide/install.md', 'docs/design.md'])('classifies a real Markdown delta %s', path => {
    expect(authorCheckDocuments([path])).toBe(true);
  });

  it.each([[], ['docs/a.md', 'src/a.ts'], ['apps/server/src/data.md'], ['docs/test/a.md'], ['docs/tests/a.md'], ['docs/e2e/a.md'], ['a.test.md'], ['a.spec.md'], ['../a.md'], ['a\\b.md']].map(paths => ({ paths })))('keeps executable, test, mixed, invalid and empty deltas out of the document shortcut: $paths', ({ paths }) => {
    expect(authorCheckDocuments(paths)).toBe(false);
  });

  it('matches the whole server assignment, including the original base and all paths', () => {
    const a = AuthorCheckRequest.parse(request);
    expect(sameAuthorCheck(a, a)).toBe(true);
    for (const key of ['requestId', 'jobId', 'agentId', 'taskId', 'repoUrl', 'branch', 'baseCommit', 'commit'] as const) expect(sameAuthorCheck(a, { ...a, [key]: 'different' })).toBe(false);
    expect(sameAuthorCheck(a, { ...a, paths: ['other.ts'] })).toBe(false);
  });

  it('carries only the server-pinned command identity and numbers the result for durable delivery', () => {
    expect(parseServerMessage(JSON.stringify(request))).toEqual(request);
    const result = parseNodeMessage(JSON.stringify(done));
    expect(result).toEqual(done);
    expect(result && isNumbered(result)).toBe(true);
  });

  it.each([{ command: 'echo passed' }, { args: ['--allow-whole'] }, { result: { exitCode: 0 } }, { repoUrl: 'file:///etc' }, { commit: 'main' }])('refuses arbitrary author inputs %j', extra => {
    expect(parseServerMessage(JSON.stringify({ ...request, ...extra }))).toBeNull();
  });

  it.each([{ crap: { kind: 'measured', max: -1 } }, { crap: { kind: 'measured', max: null } }, { finishedAt: 'tomorrow' }])('refuses invalid measurement %j', extra => {
    expect(parseNodeMessage(JSON.stringify({ ...done, ...extra }))).toBeNull();
  });
});
