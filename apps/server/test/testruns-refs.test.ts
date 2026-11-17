import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readBranches, readCommit, REFS_MAX_BYTES } from '../src/modules/testruns/refs.js';
import { listenIn } from '../../../test-support/ports.mjs';
import { closedPort } from './closed-port.js';
import { until } from './helpers-basic.js';

const ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/* A web server for one test, on its own port. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/* One commit on a new branch of the repository. */
function commitOn(dir: string, branch: string): string {
  git(dir, 'checkout', '--quiet', '-B', branch);
  writeFileSync(join(dir, 'file.txt'), `${branch} ${Date.now()} ${Math.random()}\n`);
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '--quiet', '-m', branch);
  return git(dir, 'rev-parse', 'HEAD');
}

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-refs-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  commitOn(dir, 'main');
  return dir;
}

/* A repository as a git host serves it: the advertisement comes from git itself, as its own smart HTTP backend gives it. */
async function host(dir: string, seen: IncomingMessage[] = []): Promise<string> {
  return serve((req, res) => {
    seen.push(req);
    const refs = execFileSync('git', ['upload-pack', '--http-backend-info-refs', dir]);
    res.writeHead(200, { 'content-type': ADVERTISEMENT });
    res.end(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), refs]));
  });
}

describe('reading a commit from a repository', () => {
  it('finds the exact commit a named branch is at, and the new one after it moves', async () => {
    const dir = repository();
    const first = commitOn(dir, 'task-5-checkout');
    const url = await host(dir);
    expect(await readCommit({ url, token: '' }, { branch: 'task-5-checkout' })).toEqual({ branch: 'task-5-checkout', commitSha: first });
    const second = commitOn(dir, 'task-5-checkout');
    expect(second).not.toBe(first);
    expect(await readCommit({ url, token: '' }, { branch: 'task-5-checkout' })).toEqual({ branch: 'task-5-checkout', commitSha: second });
  });

  it("finds a task's own branch by the task's number", async () => {
    const dir = repository();
    const own = commitOn(dir, 'task-5-checkout');
    commitOn(dir, 'task-50-other');
    expect(await readCommit({ url: await host(dir), token: '' }, { task: 5 })).toEqual({ branch: 'task-5-checkout', commitSha: own });
  });

  it('says which branches it cannot choose between, and that a task has none', async () => {
    const dir = repository();
    commitOn(dir, 'task-5-a');
    commitOn(dir, 'task-5-b');
    const url = await host(dir);
    expect(await readCommit({ url, token: '' }, { task: 5 })).toEqual({ problem: expect.stringContaining('task-5-a, task-5-b') });
    expect(await readCommit({ url, token: '' }, { task: 6 })).toEqual({ problem: expect.stringContaining('task-6') });
  });

  it('says a named branch is missing rather than taking another', async () => {
    const dir = repository();
    commitOn(dir, 'task-5-checkout');
    expect(await readCommit({ url: await host(dir), token: '' }, { branch: 'task-5' })).toEqual({ problem: expect.stringContaining('no branch task-5') });
  });

  it('takes the commit a tag points at, also through an annotated tag', async () => {
    const dir = repository();
    const main = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'tag', 'plain');
    git(dir, 'tag', '-a', 'noted', '-m', 'noted');
    expect(git(dir, 'rev-parse', 'noted')).not.toBe(main);
    const url = await host(dir);
    expect(await readCommit({ url, token: '' }, { branch: 'plain' })).toEqual({ branch: 'plain', commitSha: main });
    expect(await readCommit({ url, token: '' }, { branch: 'noted' })).toEqual({ branch: 'noted', commitSha: main });
  });

  it('prefers the branch to a tag of the same name, as git clone --branch does', async () => {
    const dir = repository();
    const tagged = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'tag', 'both');
    const branch = commitOn(dir, 'both');
    expect(branch).not.toBe(tagged);
    expect(await readCommit({ url: await host(dir), token: '' }, { branch: 'both' })).toEqual({ branch: 'both', commitSha: branch });
  });

  it('reads lines by their length in bytes, past a branch whose name is not ASCII', async () => {
    const dir = repository();
    commitOn(dir, 'ветка');
    const own = commitOn(dir, 'zz-after');
    expect(await readCommit({ url: await host(dir), token: '' }, { branch: 'zz-after' })).toEqual({ branch: 'zz-after', commitSha: own });
  });

  it('finds no branch in an empty repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-refs-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, 'init', '--quiet', '--initial-branch=main');
    expect(await readCommit({ url: await host(dir), token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('no branch main') });
  });

  it('asks for the refs under the address as it is saved, with or without a slash at its end', async () => {
    const dir = repository();
    const seen: IncomingMessage[] = [];
    const url = await host(dir, seen);
    await readCommit({ url: `${url}/acme/shop.git`, token: '' }, { branch: 'main' });
    await readCommit({ url: `${url}/acme/shop/`, token: '' }, { branch: 'main' });
    expect(seen.map(r => r.url)).toEqual(['/acme/shop.git/info/refs?service=git-upload-pack', '/acme/shop/info/refs?service=git-upload-pack']);
  });

  it('sends the token as git would, and no credentials when there is none', async () => {
    const dir = repository();
    const seen: IncomingMessage[] = [];
    const url = await host(dir, seen);
    await readCommit({ url, token: 'ghp_secret' }, { branch: 'main' });
    await readCommit({ url, token: '' }, { branch: 'main' });
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`);
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it('follows a moved repository, and keeps the token from any other host', async () => {
    const dir = repository();
    const seen: IncomingMessage[] = [];
    const moved = await host(dir, seen);
    const url = await serve((_req, res) => {
      res.writeHead(301, { location: `${moved}/new/info/refs?service=git-upload-pack` });
      res.end();
    });
    expect(await readCommit({ url, token: 'ghp_secret' }, { branch: 'main' })).toEqual({ branch: 'main', commitSha: git(dir, 'rev-parse', 'main') });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('says what the repository answered when it refuses, and never shows the token', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('ghp_secret is not allowed');
    });
    const read = await readCommit({ url, token: 'ghp_secret' }, { branch: 'main' });
    expect(read).toEqual({ problem: expect.stringContaining('403') });
    expect(JSON.stringify(read)).not.toContain('ghp_secret');
  });

  it('does not take a page that is no git repository for one', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Sign in</html>');
    });
    expect(await readCommit({ url, token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('not a git repository') });
  });

  it('ends on a broken answer instead of reading on', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': ADVERTISEMENT });
      res.end('zzzz not lines at all 0000');
    });
    expect(await readCommit({ url, token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('no branch main') });
  });

  it('finds no branch in an answer with no body', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(204, { 'content-type': ADVERTISEMENT });
      res.end();
    });
    expect(await readCommit({ url, token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('no branch main') });
  });

  it('stops reading an answer that will not end, at its limit', async () => {
    let sent = 0;
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': ADVERTISEMENT });
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      const more = () => {
        while (sent <= REFS_MAX_BYTES * 2 && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', more);
        }
        res.end();
      };
      more();
    });
    expect(await readCommit({ url, token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('too long') });
    expect(sent).toBeLessThan(REFS_MAX_BYTES * 2);
  });

  it('gives up on a repository that does not answer in time', async () => {
    const seen: IncomingMessage[] = [];
    const url = await serve(req => void seen.push(req));
    /* The time it may take runs out when the test says, once the repository has the ask and gives no answer. */
    const timeUp = new AbortController(), asked: number[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { asked.push(ms); return timeUp.signal; });
    onTestFinished(() => { timeout.mockRestore(); });
    const reading = readCommit({ url, token: '' }, { branch: 'main' }, 50);
    await until(() => seen.length === 1);
    expect(asked).toEqual([50]);
    timeUp.abort();
    expect(await reading).toEqual({ problem: expect.stringContaining('did not answer within 50 ms') });
  });

  it('says so when the repository cannot be reached', async () => {
    const url = await serve(() => undefined);
    const port = await closedPort();
    expect(url).not.toContain(String(port));
    expect(await readCommit({ url: `http://127.0.0.1:${port}/r.git`, token: '' }, { branch: 'main' })).toEqual({ problem: expect.stringContaining('could not be reached') });
  });
});

describe('reading every branch of a repository', () => {
  it('names each branch with the commit it is at, and no tag', async () => {
    const dir = repository();
    const main = git(dir, 'rev-parse', 'HEAD');
    const leads = commitOn(dir, 'task-37');
    const scoring = commitOn(dir, 'task-41-scoring');
    git(dir, 'tag', 'v1');
    expect(await readBranches({ url: await host(dir), token: '' })).toEqual({ heads: { main, 'task-37': leads, 'task-41-scoring': scoring } });
  });

  it('says why when the repository does not answer as one', async () => {
    const url = await serve((_req, res) => { res.writeHead(404); res.end(); });
    expect(await readBranches({ url, token: '' })).toEqual({ problem: `Hornhoof could not read the branches of ${url}: it answered 404.` });
  });
});
