import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';

/* A real git as the other end of a push over HTTP: a bare repository, and a host that hands each push to git's own
   receive-pack, so what the server sends is checked by git itself and by nothing written for the test. */
export const RESULT = 'application/x-git-receive-pack-result';
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

/* A bare repository as origin, with main and a second branch, each one commit, pushed from a work copy. */
export function origin(): { dir: string; main: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'hh-create-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'origin.git'), work = join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', dir);
  git(root, 'init', '--quiet', '--initial-branch=main', work);
  const commit = (name: string) => {
    writeFileSync(join(work, 'file.txt'), `${name}\n`);
    git(work, 'add', 'file.txt');
    git(work, 'commit', '--quiet', '-m', name);
    return git(work, 'rev-parse', 'HEAD');
  };
  const main = commit('main');
  git(work, 'checkout', '--quiet', '-b', 'other');
  const other = commit('other');
  git(work, 'push', '--quiet', dir, 'main', 'other');
  return { dir, main, other };
}

export const headOf = (dir: string, branch: string) => {
  try { return git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; }
};

/* What a git host does with a push over HTTP, by git's own receive-pack. Each push waits at hold first, so a test can
   have two in flight at once. */
export async function host(dir: string, options: { hold?: () => Promise<void>; status?: number; push?: (res: ServerResponse) => void } = {}): Promise<{ url: string; pushes: IncomingMessage[] }> {
  const pushes: IncomingMessage[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (options.status) { res.writeHead(options.status); res.end(); return; }
    if (req.method === 'GET') {
      const refs = execFileSync('git', ['receive-pack', '--http-backend-info-refs', dir]);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
      res.end(Buffer.concat([Buffer.from('001f# service=git-receive-pack\n0000'), refs]));
      return;
    }
    pushes.push(req);
    if (options.push) { options.push(res); return; }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      void (options.hold?.() ?? Promise.resolve()).then(() => {
        const child = spawn('git', ['receive-pack', '--stateless-rpc', dir], { env });
        const out: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.on('close', () => {
          res.writeHead(200, { 'content-type': RESULT });
          res.end(Buffer.concat(out));
        });
        child.stdin.end(body);
      });
    });
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/origin.git`, pushes };
}
