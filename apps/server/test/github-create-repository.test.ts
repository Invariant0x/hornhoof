import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOnGitHub } from '../src/modules/departments/github-create.js';
import { listenIn } from '../../../test-support/ports.mjs';

/* Creating a repository on GitHub with a saved key, against a GitHub of the test's own on this machine. */

const KEY = 'ghp_create0123456789abcdef';
const REPO = { name: 'marketing', description: 'Marketing in Hornhoof.' };
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: unknown };

async function github(handler: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += String(chunk)));
    req.on('end', () => {
      const one = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(one);
      handler(one, res);
    });
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/* GitHub where the key is Ivan's: a repository goes to his account or to an organization, as asked, unless the answer for
   that request is given. */
const asIvan = (answer?: (res: ServerResponse) => void) => (req: Seen, res: ServerResponse) => {
  if (req.url === '/user') return json(res, 200, { login: 'Ivan' });
  if (answer) return answer(res);
  const owner = req.url === '/user/repos' ? 'Ivan' : req.url.split('/')[2]!;
  const name = (req.body as { name: string }).name;
  return json(res, 201, { clone_url: `https://github.com/${owner}/${name}.git`, html_url: `https://github.com/${owner}/${name}`, default_branch: 'trunk' });
};

describe('creating a repository on GitHub', () => {
  it("creates a private one with a first commit in the key's own account when the owner is the key's user, in any case", async () => {
    const hub = await github(asIvan());
    const made = await createOnGitHub(hub.api)({ provider: 'github', owner: 'ivan', token: KEY }, REPO);
    expect(made).toEqual({ url: 'https://github.com/Ivan/marketing.git', branch: 'trunk', page: 'https://github.com/Ivan/marketing' });
    expect(hub.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /user', 'POST /user/repos']);
    for (const s of hub.seen) {
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(s.headers.accept).toBe('application/vnd.github+json');
    }
    expect(hub.seen[1]!.body).toEqual({ name: 'marketing', description: 'Marketing in Hornhoof.', private: true, auto_init: true });
  });

  it('creates it in the organization the owner names otherwise', async () => {
    const hub = await github(asIvan());
    const made = await createOnGitHub(hub.api)({ provider: 'github', owner: 'acme', token: KEY }, REPO);
    expect(made).toEqual({ url: 'https://github.com/acme/marketing.git', branch: 'trunk', page: 'https://github.com/acme/marketing' });
    expect(hub.seen.map(s => `${s.method} ${s.url}`)).toEqual(['GET /user', 'POST /orgs/acme/repos']);
  });

  it.each([
    [422, /named marketing for acme already|another name/],
    [403, /may not create repositories for acme/],
    [404, /no organization acme/],
    [500, /GitHub answered 500/],
  ])('says what to do when GitHub answers %i, never with the key', async (status, words) => {
    const hub = await github(asIvan(res => json(res, status, { message: 'no' })));
    const made = await createOnGitHub(hub.api)({ provider: 'github', owner: 'acme', token: KEY }, REPO);
    expect(made).toEqual({ problem: expect.stringMatching(words) });
    expect(JSON.stringify(made)).not.toContain(KEY);
  });

  it('asks for a new key when GitHub does not take this one, and creates nothing', async () => {
    const hub = await github((_req, res) => json(res, 401, { message: 'Bad credentials' }));
    const made = await createOnGitHub(hub.api)({ provider: 'github', owner: 'acme', token: KEY }, REPO);
    expect(made).toEqual({ problem: expect.stringMatching(/new key/) });
    expect(hub.seen.map(s => s.url)).toEqual(['/user']);
  });

  it('follows no redirect, so the key stays with GitHub', async () => {
    const other = await github(asIvan());
    const hub = await github((_req, res) => json(res, 307, {}, { location: `${other.api}/user` }));
    const made = await createOnGitHub(hub.api)({ provider: 'github', owner: 'acme', token: KEY }, REPO);
    expect(made).toEqual({ problem: expect.stringContaining('GitHub answered 307') });
    expect(other.seen).toEqual([]);
  });

  it('says so when GitHub cannot be reached or does not answer in time', async () => {
    const hub = await github(() => {});
    const closed = `${hub.api.replace(/:\d+$/, '')}:1`;
    expect(await createOnGitHub(closed)({ provider: 'github', owner: 'acme', token: KEY }, REPO)).toEqual({ problem: expect.stringContaining('could not be reached') });
    expect(await createOnGitHub(hub.api, 50)({ provider: 'github', owner: 'acme', token: KEY }, REPO)).toEqual({ problem: expect.stringContaining('did not answer within 50 ms') });
  });
});
