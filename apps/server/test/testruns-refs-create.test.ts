import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createBranch } from '../src/modules/testruns/refs.js';
import { listenIn } from '../../../test-support/ports.mjs';
import { RESULT, git, headOf, host, origin } from './git-origin.js';

describe('making a branch in a repository', () => {
  it('makes a branch the repository does not have, at exactly that commit, by a push git itself takes', async () => {
    const { dir, main } = origin();
    const { url } = await host(dir);
    expect(await createBranch({ url, token: '' }, 'turn-30', main)).toEqual({ made: true });
    expect(headOf(dir, 'turn-30')).toBe(main);
    expect(headOf(dir, 'main')).toBe(main);
  });

  it('never moves a branch that is there: it asks for one only where there is none, and says so', async () => {
    const { dir, main, other } = origin();
    git(dir, 'branch', 'turn-30', other);
    const { url, pushes } = await host(dir);
    expect(await createBranch({ url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('turn-30') as unknown });
    expect(headOf(dir, 'turn-30')).toBe(other);
    expect(pushes).toHaveLength(0);
  });

  it('lets only one of two that make the same branch at once have it: the other is refused and moves nothing', async () => {
    const { dir, main, other } = origin();
    let release: () => void = () => undefined;
    const both = new Promise<void>(done => { release = done; });
    let waiting = 0;
    /* Both pushes are in before either is taken; git's lock on the branch then lets one through. */
    const { url, pushes } = await host(dir, {
      hold: async () => {
        if (++waiting === 2) release();
        await both;
      },
    });
    const [first, second] = await Promise.all([createBranch({ url, token: '' }, 'turn-30', main), createBranch({ url, token: '' }, 'turn-30', other)]);
    expect(pushes).toHaveLength(2);
    const made = [first, second].filter(answer => 'made' in answer);
    expect(made).toHaveLength(1);
    expect([first, second].filter(answer => 'problem' in answer)).toEqual([{ problem: expect.stringContaining('turn-30') as unknown }]);
    expect(headOf(dir, 'turn-30')).toBe('made' in first ? main : other);
  });

  it('says why when the repository will not take it, and never with the token', async () => {
    const { dir, main } = origin();
    const { url } = await host(dir, { status: 403 });
    const answer = await createBranch({ url, token: 'secret-token-0123456789' }, 'turn-30', main);
    expect(answer).toEqual({ problem: expect.stringMatching(/turn-30.*403/) as unknown });
    expect(JSON.stringify(answer)).not.toContain('secret-token');
    expect(headOf(dir, 'turn-30')).toBeNull();
  });

  it('says why when the commit is not in the repository, and makes nothing', async () => {
    const { dir } = origin();
    const { url } = await host(dir);
    expect(await createBranch({ url, token: '' }, 'turn-30', '7'.repeat(40))).toEqual({ problem: expect.stringContaining('turn-30') as unknown });
    expect(headOf(dir, 'turn-30')).toBeNull();
  });

  it('says the repository moved when the push is sent on, and follows it nowhere', async () => {
    const { dir, main } = origin();
    const { url, pushes } = await host(dir, { push: res => { res.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere.git/git-receive-pack' }); res.end(); } });
    expect(await createBranch({ url, token: 'secret-token-0123456789' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('moved') as unknown });
    expect(pushes).toHaveLength(1);
    expect(headOf(dir, 'turn-30')).toBeNull();
  });

  it('says what the repository answered to the push, and when its answer is no answer to a push', async () => {
    const { dir, main } = origin();
    const failing = await host(dir, { push: res => { res.writeHead(500); res.end(); } });
    expect(await createBranch({ url: failing.url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('it answered 500') as unknown });
    const page = await host(dir, { push: res => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); } });
    expect(await createBranch({ url: page.url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('not a git repository') as unknown });
    const endless = await host(dir, { push: res => { res.writeHead(200, { 'content-type': RESULT }); res.end(Buffer.alloc(70 * 1024, 0x30)); } });
    expect(await createBranch({ url: endless.url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('too long') as unknown });
    expect(headOf(dir, 'turn-30')).toBeNull();
  });

  it('says what git said when it took no pack, and when its answer names no branch', async () => {
    const { dir, main } = origin();
    const line = (text: string) => `${(text.length + 5).toString(16).padStart(4, '0')}${text}\n`;
    const unpacked = await host(dir, { push: res => { res.writeHead(200, { 'content-type': RESULT }); res.end(`${line('unpack index-pack abnormal exit')}0000`); } });
    expect(await createBranch({ url: unpacked.url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('it refused: unpack index-pack abnormal exit') as unknown });
    const silent = await host(dir, { push: res => { res.writeHead(200, { 'content-type': RESULT }); res.end(`${line('unpack ok')}0000`); } });
    expect(await createBranch({ url: silent.url, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('says nothing of the branch') as unknown });
  });

  it('takes no branch name or commit git would not take as one', async () => {
    const { dir, main } = origin();
    const { url, pushes } = await host(dir);
    for (const [branch, commit] of [['turn 30', main], ['turn-30\nrefs/heads/main', main], ['../main', main], ['turn-30', 'not-a-commit']] as const) {
      expect(await createBranch({ url, token: '' }, branch, commit)).toEqual({ problem: expect.stringContaining('not one git takes') as unknown });
    }
    expect(pushes).toHaveLength(0);
  });

  it('says it could not reach a repository that does not answer', async () => {
    const { main } = origin();
    const server = createServer();
    await listenIn(server);
    const { port } = server.address() as AddressInfo;
    await new Promise<void>(done => server.close(() => done()));
    expect(await createBranch({ url: `http://127.0.0.1:${port}/origin.git`, token: '' }, 'turn-30', main)).toEqual({ problem: expect.stringContaining('could not be reached') as unknown });
  });
});
