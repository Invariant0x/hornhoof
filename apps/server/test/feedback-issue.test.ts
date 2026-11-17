import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { issueOf, openIssueOnGitHub } from '../src/modules/feedback/github-issue.js';
import { listenIn } from '../../../test-support/ports.mjs';
import { agents, companies, departments, people } from '../src/db/schema.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

/* A card of the inbox becomes an issue in invariant0x/hornhoof with one press, against a GitHub of the test's own on this
   machine that answers with GitHub's own example of the answer to creating an issue (github/rest-api-description 1.1.4,
   components/examples/issue), so nothing reaches the network. */

const CREATED = readFileSync(new URL('./fixtures/github-issue-created.json', import.meta.url), 'utf8');
const KEY = 'github_pat_11ISSUES0123456789_abcdefghijklmnopqrstuvwxyz';
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: unknown };

async function github(answer: (req: Seen, res: ServerResponse) => void = created) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += String(chunk)));
    req.on('end', () => {
      const one = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(one);
      answer(one, res);
    });
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function created(_req: Seen, res: ServerResponse) {
  res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', location: 'https://api.github.com/repos/octocat/Hello-World/issues/1347' });
  res.end(CREATED);
}
const status = (code: number, body: object = { message: 'refused' }, headers: Record<string, string> = {}) => (_req: Seen, res: ServerResponse) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const ISSUE = { repo: 'octocat/Hello-World', title: 'Bug: Terminal froze', body: 'Text' };
const key = { provider: 'github' as const, owner: 'invariant0x', token: KEY };

describe('opening an issue on GitHub', () => {
  it('creates it in the repository with the key and takes its number and page from what GitHub answered', async () => {
    const hub = await github();
    expect(await openIssueOnGitHub(hub.api)(key, ISSUE)).toEqual({ number: 1347, url: 'https://github.com/octocat/Hello-World/issues/1347' });
    expect(hub.seen.map(s => `${s.method} ${s.url}`)).toEqual(['POST /repos/octocat/Hello-World/issues']);
    expect(hub.seen[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    expect(hub.seen[0]!.body).toEqual({ title: 'Bug: Terminal froze', body: 'Text' });
  });

  it('says what to do when GitHub refuses, never with the key, and follows no redirect', async () => {
    const cases: [ReturnType<typeof status>, RegExp][] = [
      [status(401), /does not take this key/],
      [status(403), /Issues/],
      [status(404), /no repository octocat\/Hello-World/],
      [status(410), /turned issues off/],
      [status(422), /did not take/],
      [status(302, {}, { location: 'https://elsewhere.example/steal' }), /GitHub answered 302/],
    ];
    for (const [answer, says] of cases) {
      const hub = await github(answer);
      const made = await openIssueOnGitHub(hub.api)(key, ISSUE);
      expect(made).toEqual({ problem: expect.stringMatching(says) });
      expect(JSON.stringify(made)).not.toContain(KEY);
      expect(hub.seen).toHaveLength(1);
    }
  });

  it('keeps only a page on github.com that ends in the number it gave', async () => {
    const elsewhere = await github(status(201, { number: 7, html_url: 'javascript:alert(1)//issues/7' }));
    expect(await openIssueOnGitHub(elsewhere.api)(key, ISSUE)).toEqual({ problem: expect.stringMatching(/did not say where/) });
    const mismatch = await github(status(201, { number: 7, html_url: 'https://github.com/octocat/Hello-World/issues/8' }));
    expect(await openIssueOnGitHub(mismatch.api)(key, ISSUE)).toEqual({ problem: expect.stringMatching(/did not say where/) });
  });

  it('writes what came from installations inside a code block no text can close, so nothing in it links, mentions or runs', () => {
    const card = {
      kind: 'bug' as const,
      title: 'Froze\n@octocat <img src=x onerror=alert(1)>\u0007',
      text: 'Ping @octocat, see [this](https://evil.example), <b>bold</b>\n```\nbreak out\n````\nstill inside',
      errorCode: 'terminal_lost',
      versions: ['0.18.11'],
      platforms: ['linux x64'],
      signals: 5,
      installations: 3,
      priority: 'high' as const,
    };
    const issue = issueOf(card);
    expect(issue.repo).toBe('invariant0x/hornhoof');
    expect(issue.title).toBe('Bug: Froze @octocat <img src=x onerror=alert(1)>');
    const fence = '`````';
    expect(issue.body).toBe(
      'Sent from Hornhoof installations through the feedback inbox.\n\n' +
        `${fence}text\nKind: bug\nPriority: high\nSignals: 5 from 3 installations\nVersions: 0.18.11\nPlatforms: linux x64\nError code: terminal_lost\n${fence}\n\n` +
        `${fence}text\n${card.text}\n${fence}\n`,
    );
    /* Everything outside the blocks is the program's own words. */
    expect(issue.body.split(fence).filter((_, i) => i % 2 === 0).join('')).not.toMatch(/@|<|\[|evil/);
  });
});

describe('turning an inbox card into an issue', () => {
  async function inbox(env: NodeJS.ProcessEnv = { FEEDBACK_INBOX: 'true' }) {
    const { app } = await testApp(env);
    const ceo = await setUpCompany(app);
    const hub = await github();
    app.ctx.createIssue = openIssueOnGitHub(hub.api);
    const receive = (title: string) =>
      app.inject({ method: 'POST', url: '/api/feedback/inbound', payload: { v: 1, installation: 'a'.repeat(32), kind: 'bug', title, text: 'It froze.', facts: { version: '0.18.11', platform: ['linux x64'], errorCode: null } } });
    const card = async (title: string) => {
      await receive(title);
      return (await app.inject({ url: '/api/feedback/inbox', ...as(ceo) })).json().cards.find((c: { title: string }) => c.title === title);
    };
    const issue = (id: string) => app.inject({ method: 'POST', url: `/api/feedback/inbox/${id}/issue`, ...as(ceo) });
    const saveKey = (owner: string, url = '/api/repo-host') => app.inject({ method: 'PUT', url, payload: { owner, token: KEY }, ...as(ceo) });
    return { app, ceo, hub, card, issue, saveKey };
  }

  it('opens it with the GitHub key the company saved for invariant0x, and keeps its number and page on the card', async () => {
    const { app, ceo, hub, card, issue, saveKey } = await inbox();
    expect((await saveKey('invariant0x')).statusCode).toBe(200);
    const froze = await card('Terminal froze');
    const opened = await issue(froze.id);
    expect([opened.statusCode, opened.json()]).toEqual([200, { issue: { number: 1347, url: 'https://github.com/octocat/Hello-World/issues/1347' } }]);
    expect(hub.seen.map(s => `${s.method} ${s.url} ${s.headers.authorization}`)).toEqual([`POST /repos/invariant0x/hornhoof/issues Bearer ${KEY}`]);
    expect(hub.seen[0]!.body).toMatchObject({ title: 'Bug: Terminal froze', body: expect.stringContaining('It froze.') });
    const [listed] = (await app.inject({ url: '/api/feedback/inbox', ...as(ceo) })).json().cards;
    expect(listed.issue).toEqual({ number: 1347, url: 'https://github.com/octocat/Hello-World/issues/1347' });
    const twice = await issue(froze.id);
    expect([twice.statusCode, twice.json().error.reason]).toEqual([409, 'feedback_issued']);
    expect(hub.seen).toHaveLength(1);
  });

  it('is for people who see the whole company: anyone else is refused, and GitHub is asked nothing', async () => {
    const { app, ceo, hub, card, saveKey } = await inbox();
    await saveKey('invariant0x');
    const froze = await card('Terminal froze');
    const [dev] = await app.ctx.db.insert(departments).values({ companyId: (await app.ctx.db.select().from(companies))[0]!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev!.id] } });
    const refused = await app.inject({ method: 'POST', url: `/api/feedback/inbox/${froze.id}/issue`, ...as(dana) });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([403, 'company_scope_only']);
    expect(hub.seen).toEqual([]);
    expect((await app.inject({ url: '/api/feedback/inbox', ...as(ceo) })).json().cards[0].issue).toBeNull();
  });

  it('opens it for the orchestrator acting for the owner, as for a person pressing the button', async () => {
    const { app, hub, card, saveKey } = await inbox();
    await saveKey('invariant0x');
    const froze = await card('Terminal froze');
    const [agent] = await app.ctx.db.select().from(agents);
    const [owner] = await app.ctx.db.select().from(people);
    const opened = await app.inject({ method: 'POST', url: `/api/feedback/inbox/${froze.id}/issue`, headers: orchestratorHeaders(owner!.id, agent!.id) });
    expect([opened.statusCode, opened.json()]).toEqual([200, { issue: { number: 1347, url: 'https://github.com/octocat/Hello-World/issues/1347' } }]);
    expect(hub.seen).toHaveLength(1);
  });

  it('opens one issue when two people press at once', async () => {
    const { hub, card, issue, saveKey } = await inbox();
    await saveKey('invariant0x');
    const froze = await card('Terminal froze');
    const both = await Promise.all([issue(froze.id), issue(froze.id)]);
    expect(both.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(hub.seen).toHaveLength(1);
  });

  it('says it has no key when none is saved for invariant0x, and asks GitHub nothing', async () => {
    const { hub, card, issue, saveKey } = await inbox();
    const froze = await card('Terminal froze');
    const none = await issue(froze.id);
    expect([none.statusCode, none.json().error.reason]).toEqual([409, 'feedback_no_github_key']);
    await saveKey('acme-corp');
    expect((await issue(froze.id)).json().error.reason).toBe('feedback_no_github_key');
    expect(hub.seen).toEqual([]);
  });

  it("passes on GitHub's refusal and leaves the card without an issue", async () => {
    const { app, ceo, card, saveKey } = await inbox();
    await saveKey('invariant0x');
    const refusing = await github(status(403));
    app.ctx.createIssue = openIssueOnGitHub(refusing.api);
    const froze = await card('Terminal froze');
    const refused = await app.inject({ method: 'POST', url: `/api/feedback/inbox/${froze.id}/issue`, ...as(ceo) });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([502, 'feedback_issue_refused']);
    expect((await app.inject({ url: '/api/feedback/inbox', ...as(ceo) })).json().cards[0].issue).toBeNull();
  });

  it('is not there on an installation without FEEDBACK_INBOX', async () => {
    const { app, ceo } = await inbox({});
    expect((await app.inject({ method: 'POST', url: '/api/feedback/inbox/00000000-0000-4000-8000-000000000001/issue', ...as(ceo) })).statusCode).toBe(404);
  });
});
