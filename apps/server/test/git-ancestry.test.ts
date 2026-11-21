import { beforeEach, expect, it, vi } from 'vitest';
import { readGitAncestry } from '../src/modules/testruns/git-ancestry.js';

type Exit = Error & { code: number };
type Run = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }, done: (error: Exit | null, stdout: string) => void) => void;
const exec = vi.hoisted(() => vi.fn<Run>());
vi.mock('node:child_process', () => ({ execFile: exec }));

const head = 'a'.repeat(40);
const ancestor = 'b'.repeat(40);
const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token' };
beforeEach(() => { exec.mockReset(); });

it.each([[0, true], [1, false], [128, null]] as const)('checks the exact Git objects, interpreting merge-base exit %s', async (code, expected) => {
  exec.mockImplementation((_file, args, _options, done) => {
    if (args.includes('merge-base') && code !== 0) return done(Object.assign(new Error('Git stopped.'), { code }), '');
    done(null, args.includes('cat-file') ? 'commit\n' : '');
  });
  expect(await readGitAncestry(repo, head, ancestor, 10_000)).toBe(expected);
  const fetch = exec.mock.calls.find(([, args]) => args.includes('fetch'))!;
  expect(fetch[1]).toEqual(expect.arrayContaining(['--filter=tree:0', '--no-recurse-submodules', 'http.followRedirects=false']));
  expect(fetch[1].slice(-4)).toEqual(['--', repo.url, head, ancestor]);
  expect(JSON.stringify(fetch.slice(0, 3))).not.toContain(repo.token);
  expect(exec.mock.calls.at(-1)![1].slice(-4)).toEqual(['merge-base', '--is-ancestor', ancestor, head]);
});

it('leaves ancestry unknown before Git runs for untrusted repositories or unpinned refs', async () => {
  expect(await readGitAncestry({ ...repo, url: 'https://github.com.example.test/acme/shop.git' }, head, ancestor, 10_000)).toBeNull();
  expect(await readGitAncestry(repo, 'main', ancestor, 10_000)).toBeNull();
  expect(exec).not.toHaveBeenCalled();
});
