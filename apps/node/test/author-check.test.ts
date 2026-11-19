import { describe, expect, it } from 'vitest';
import type { AuthorCheckPin } from '@hornhoof/protocol';
import { authorCrap } from '../src/author-check.js';
import { matchingAuthorPatch } from '../src/author-patch.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const SOURCE = 'd'.repeat(40);
const PATCH_ID = 'e'.repeat(40);
const OTHER_ID = 'f'.repeat(40);
const uuid = '11111111-1111-4111-8111-111111111111';
const pin: AuthorCheckPin = { taskId: uuid, agentId: uuid, branch: 'task-1', baseCommit: BASE, commit: HEAD, repoUrlHash: 'a'.repeat(64), paths: ['logic/totals.ts'] };

function record(change = pin, stage: Partial<{ status: string; exitCode: number | null; reason: string }> = {}, score: number | null = 2) {
  return JSON.stringify({
    version: 1, submissionCommit: change.commit, checkCommit: change.commit, scope: { kind: 'changed', paths: change.paths },
    stages: ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'].map(name => ({
      name, status: 'passed', exitCode: 0, ...(name === 'crapper' ? stage : {}),
    })),
    numbers: { worstCrap: score },
  });
}

describe('author check receipts', () => {
  it('reads the score only from a single consistent result for the pinned change', () => {
    expect(authorCrap([record()], pin)).toBe(2);
    expect(authorCrap([record(), record()], pin)).toBeNull();
    expect(authorCrap([record({ ...pin, commit: SOURCE })], pin)).toBeNull();
    expect(authorCrap([record({ ...pin, paths: ['README.md'] })], pin)).toBeNull();
    expect(authorCrap([record(pin, { status: 'failed', exitCode: 1 })], pin)).toBeNull();
  });

  it('requires the CRAP stage to account for an empty score explicitly', () => {
    expect(authorCrap([record(pin, {}, null)], pin)).toBeNull();
    expect(authorCrap([record(pin, { reason: 'no_new_or_grown_functions' }, null)], pin)).toBe(0);
  });

  it('distinguishes docs with no source from unknown CRAP', () => {
    const docs = { ...pin, paths: ['docs/guide.txt'] };
    expect(authorCrap([record(docs, { status: 'unavailable', exitCode: null, reason: 'no_source_changed' }, null)], docs)).toBe(0);
    expect(authorCrap([record(docs, { status: 'unavailable', exitCode: null, reason: 'no_coverage_adapter' }, null)], docs)).toBeNull();
  });
});

describe('clean cherry-pick proof from the repository mirror', () => {
  it.each([PATCH_ID, OTHER_ID, null])('uses only a full patch from the pinned line history (%s)', async sourcePatchId => {
    const candidatePatch = Buffer.from('candidate diff');
    const fullSourcePatch = Buffer.from('full source diff');
    const commands: string[][] = [];
    const read = (args: string[], input?: Buffer): Promise<Buffer> => {
      commands.push(args);
      if (args[0] === 'diff') return Promise.resolve(candidatePatch);
      if (args[0] === 'rev-list') return Promise.resolve(Buffer.from(sourcePatchId ? SOURCE + '\n' : ''));
      if (args[0] === 'diff-tree') return Promise.resolve(fullSourcePatch);
      if (input === candidatePatch) return Promise.resolve(Buffer.from(PATCH_ID + ' ' + '0'.repeat(40) + '\n'));
      if (input === fullSourcePatch) return Promise.resolve(Buffer.from(sourcePatchId + ' ' + SOURCE + '\n'));
      throw new Error('Unexpected Git command');
    };

    expect(await matchingAuthorPatch(pin, MAIN, read)).toBe(sourcePatchId === PATCH_ID ? SOURCE : null);
    expect(commands[1]).toEqual(['patch-id', '--stable']);
    expect(commands[2]).toContain(BASE);
    expect(commands[2]).toContain(MAIN);
    if (sourcePatchId) expect(commands[3]?.at(-1)).toBe(SOURCE);
  });
});
