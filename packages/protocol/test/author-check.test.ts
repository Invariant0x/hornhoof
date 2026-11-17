import { describe, expect, it } from 'vitest';
import { isNumbered, parseNodeMessage, parseServerMessage } from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const request = { type: 'author_check.run', requestId: id, jobId: id, agentId: id, taskId: id,
  repoUrl: 'https://github.com/acme/shop.git', branch: 'task-1', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), paths: ['logic/totals.ts'] };
const done = { ...request, type: 'author_check.done', exitCode: 0, crap: { kind: 'measured', max: 2 },
  startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:01.000Z', reason: null };

describe('node-owned author check messages', () => {
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
