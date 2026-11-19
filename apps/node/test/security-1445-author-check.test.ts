import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorCheckPin } from '@hornhoof/protocol';
import { authorCrap } from '../src/author-check.js';
import { matchingAuthorPatch } from '../src/author-patch.js';

/* Security probes of #1445 against d877a6a4 (#1217). Each test states the safe behaviour, so it fails while the hole is open. */

const uuid = '11111111-1111-4111-8111-111111111111';
const NAMES = ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'] as const;
type Stage = { name: string; status: string; exitCode: number | null; reason?: string };

function pinOf(commit: string, baseCommit: string, paths: string[]): AuthorCheckPin {
  return { taskId: uuid, agentId: uuid, branch: 'task-1', baseCommit, commit, repoUrlHash: 'a'.repeat(64), paths };
}

/* The record runStages writes, with the given stages over the defaults of a full pass. */
function record(pin: AuthorCheckPin, stages: Partial<Record<(typeof NAMES)[number], Partial<Stage>>>, worstCrap: number | null) {
  return JSON.stringify({
    version: 1, submissionCommit: pin.commit, checkCommit: pin.commit, scope: { kind: 'changed', paths: pin.paths },
    stages: NAMES.map(name => ({ name, status: 'passed', exitCode: 0, partId: null, ...stages[name] })),
    numbers: { tests: null, changedLines: null, worstCrap, dryerFlags: null },
  });
}

describe('F2: a partial author check is not a green receipt', () => {
  const pin = pinOf('b'.repeat(40), 'a'.repeat(40), ['apps/server/src/modules/auth/session.ts']);
  const noTests = { status: 'unavailable', exitCode: null, reason: 'nothing_selected' };

  it('refuses a receipt when no test ran for a changed source', () => {
    /* scripts/author-check: tests unavailable nothing_selected is DECLARED, so the driver exits 0. */
    expect(authorCrap([record(pin, { tests: noTests }, 3)], pin)).toBeNull();
  });

  it('never turns a missing CRAP into 0 when every changed function is only touched', () => {
    /* crapperStage: every function >= 10 and not grown is TOUCHED, worstCrap stays null, reason no_new_or_grown_functions. */
    const touchedOnly = record(pin, { tests: noTests, crapper: { reason: 'no_new_or_grown_functions' } }, null);
    expect(authorCrap([touchedOnly], pin)).toBeNull();
  });
});

/* A Git reader with the same calls as authorGit in test-mirror.ts, over a real repository. */
function realGit(dir: string) {
  return (args: string[], input?: Buffer): Promise<Buffer> => Promise.resolve(input
    ? execFileSync('git', args, { input })
    : execFileSync('git', ['--literal-pathspecs', '--git-dir', join(dir, '.git'), ...args]));
}

describe('F3 and F4: the cherry-pick proof is an exact patch from work not yet in the turn', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const commit = (path: string, text: string, message: string) => {
    writeFileSync(join(dir, path), text);
    git('add', path);
    git('-c', 'user.name=probe', '-c', 'user.email=probe@invalid', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const repository = () => {
    dir = mkdtempSync(join(tmpdir(), 'hh-sec-1445-'));
    git('init', '-q', '-b', 'main');
  };

  it('F3: a whitespace change inside a string is not the same patch', async () => {
    repository();
    const base = commit('clean.ts', "export const before = 1;\nexport const cmd = 'ls';\nexport const after = 2;\n", 'base');
    const fix = commit('clean.ts', "export const before = 1;\nexport const cmd = 'rm -rf /tmp/cache';\nexport const after = 2;\n", 'main: clear the cache');
    git('checkout', '-q', '-b', 'task-1', base);
    const candidate = commit('clean.ts', "export const before = 1;\nexport const cmd = 'rm -rf / tmp/cache';\nexport const after = 2;\n", 'forward port');
    expect(await matchingAuthorPatch(pinOf(candidate, base, ['clean.ts']), fix, realGit(dir))).toBeNull();
  });

  it('F4: re-adding code a later commit removed is not a clean cherry-pick', async () => {
    repository();
    commit('gate.ts', 'export function gate(req, next) {\n  check(req);\n  return next();\n}\n', 'gate');
    const bypass = commit('gate.ts', "export function gate(req, next) {\n  if (req.headers['x-debug']) return next();\n  check(req);\n  return next();\n}\n", 'debug bypass');
    const fixed = commit('gate.ts', 'export function gate(req, next) {\n  check(req);\n  return next();\n}\n', 'security: remove the debug bypass');
    git('checkout', '-q', '-b', 'task-1', fixed);
    const candidate = commit('gate.ts', "export function gate(req, next) {\n  if (req.headers['x-debug']) return next();\n  check(req);\n  return next();\n}\n", 'bring back');
    const found = await matchingAuthorPatch(pinOf(candidate, fixed, ['gate.ts']), fixed, realGit(dir));
    expect({ found, bypassIsInTheTurn: git('merge-base', '--is-ancestor', bypass, fixed) === '' }).toEqual({ found: null, bypassIsInTheTurn: true });
  });
});
