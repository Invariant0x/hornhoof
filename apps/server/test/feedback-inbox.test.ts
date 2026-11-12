import { describe, expect, it } from 'vitest';
import { companies, departments, feedbackInbox } from '../src/db/schema.js';
import { fakeRelay } from './fake-relay.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

/* Hornhoof's own installation, where FEEDBACK_INBOX is set, takes the reports every installation sends through
   hornhoof.org into one list: repeats become one card that counts its signals and the installations they came from, each
   card with its kind and a priority. */

const HOUR = 60 * 60 * 1000;
const installationId = (n: number) => n.toString(16).padStart(32, 'a');
const report = (over: Record<string, unknown> = {}) => ({
  v: 1,
  installation: installationId(1),
  kind: 'bug',
  title: 'Terminal froze after an update',
  text: 'The agent terminal stayed black.',
  facts: { version: '0.18.11', platform: ['linux x64'], errorCode: null },
  ...over,
});

async function inbox(env: NodeJS.ProcessEnv = { FEEDBACK_INBOX: 'true' }) {
  const relay = await fakeRelay();
  const { app, db } = await testApp({ RELAY_URL: relay.url, ...env });
  const ceo = await setUpCompany(app);
  let now = Date.parse('2026-11-12T12:00:00Z');
  app.ctx.clock = () => now;
  const later = (ms: number) => (now += ms);
  const receive = (payload: unknown) => app.inject({ method: 'POST', url: '/api/feedback/inbound', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  const cards = async (token = ceo) => (await app.inject({ url: '/api/feedback/inbox', ...as(token) })).json().cards;
  return { app, db, relay, ceo, receive, cards, later };
}

describe('the inbox of Hornhoof developers', () => {
  it('is only on the installation FEEDBACK_INBOX names', async () => {
    const { receive, app, ceo } = await inbox({});
    expect((await receive(report())).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/feedback/inbox', ...as(ceo) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/feedback', ...as(ceo) })).json()).toEqual({ inbox: false });
  });

  it('takes a report without a session and lists it for people who see the whole company', async () => {
    const { app, db, ceo, receive, cards } = await inbox();
    expect((await app.inject({ url: '/api/feedback', ...as(ceo) })).json()).toEqual({ inbox: true });
    const taken = await receive(report());
    expect([taken.statusCode, taken.json()]).toEqual([202, { received: true }]);
    expect(await cards()).toEqual([
      {
        id: expect.any(String),
        kind: 'bug',
        title: 'Terminal froze after an update',
        text: 'The agent terminal stayed black.',
        errorCode: null,
        versions: ['0.18.11'],
        platforms: ['linux x64'],
        signals: 1,
        installations: 1,
        priority: 'normal',
        firstAt: '2026-11-12T12:00:00.000Z',
        lastAt: '2026-11-12T12:00:00.000Z',
        issue: null,
      },
    ]);
    const [dev] = await db.insert(departments).values({ companyId: (await db.select().from(companies))[0]!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev!.id] } });
    expect((await app.inject({ url: '/api/feedback/inbox', ...as(dana) })).statusCode).toBe(403);
  });

  it('refuses a report of another shape and stores nothing of it', async () => {
    const { app, db, receive } = await inbox();
    const wrong = [
      { ...report(), v: 2 },
      { ...report(), kind: 'complaint' },
      { ...report(), installation: 'not-an-id' },
      { ...report(), title: '' },
      { ...report(), title: 'x'.repeat(201) },
      { ...report(), text: 'x'.repeat(5001) },
      { ...report(), facts: { version: '0.18.11', platform: ['linux x64'], errorCode: 'Not A Code' } },
      { ...report(), facts: { version: '0.18.11', platform: Array.from({ length: 11 }, (_, i) => `linux ${i}`), errorCode: null } },
      { ...report(), extra: 'field' },
      'just text',
    ];
    for (const payload of wrong) expect((await receive(payload)).statusCode).toBe(400);
    const plain = await app.inject({ method: 'POST', url: '/api/feedback/inbound', headers: { 'content-type': 'text/plain' }, payload: 'just text' });
    expect(plain.statusCode).toBe(400);
    expect(await db.select().from(feedbackInbox)).toEqual([]);
  });

  it('refuses a body over 16 KB', async () => {
    const { app, db } = await inbox();
    const big = await app.inject({ method: 'POST', url: '/api/feedback/inbound', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...report(), padding: 'x'.repeat(17 * 1024) }) });
    expect(big.statusCode).toBe(413);
    expect(await db.select().from(feedbackInbox)).toEqual([]);
  });

  it('keeps what came as plain text, cleaned once more, without control characters', async () => {
    const { receive, cards } = await inbox();
    await receive(report({ title: 'Click <script>alert(1)</script> [here](javascript:alert(1))', text: 'Key ghp_0123456789abcdefghijABCDEFGHIJ012345\u0007 and\u202e mail ivan@acme.example\nnext line' }));
    const [card] = await cards();
    expect(card.title).toBe('Click <script>alert(1)</script> [here](javascript:alert(1))');
    expect(card.text).toBe('Key [secret] and mail [email]\nnext line');
  });

  it('makes one card of repeats, counting signals and installations, and keeps another kind apart', async () => {
    const { receive, cards, later } = await inbox();
    await receive(report({ title: 'Terminal froze after update 18', facts: { version: '0.18.9', platform: ['linux x64'], errorCode: null } }));
    later(1000);
    await receive(report({ installation: installationId(2), title: 'terminal FROZE, after update 19!' }));
    later(1000);
    await receive(report({ installation: installationId(2), title: 'Terminal froze after update 19', facts: { version: '0.18.11', platform: ['darwin arm64'], errorCode: null } }));
    later(1000);
    await receive(report({ kind: 'idea', title: 'Terminal froze after update 18' }));
    const [bug, idea] = (await cards()).sort((a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind));
    expect(bug).toMatchObject({ kind: 'bug', title: 'Terminal froze after update 18', signals: 3, installations: 2, versions: ['0.18.11', '0.18.9'], platforms: ['darwin arm64', 'linux x64'], firstAt: '2026-11-12T12:00:00.000Z', lastAt: '2026-11-12T12:00:02.000Z' });
    expect(idea).toMatchObject({ kind: 'idea', signals: 1, installations: 1 });
  });

  it('tells repeats apart by their error code', async () => {
    const { receive, cards } = await inbox();
    await receive(report({ facts: { version: '0.18.11', platform: [], errorCode: 'terminal_lost' } }));
    await receive(report({ installation: installationId(2), facts: { version: '0.18.11', platform: [], errorCode: 'queue_stuck' } }));
    expect((await cards()).map((c: { errorCode: string }) => c.errorCode).sort()).toEqual(['queue_stuck', 'terminal_lost']);
  });

  it('puts a bug from three installations first, then other bugs and what many asked for, then the rest', async () => {
    const { receive, cards, later } = await inbox();
    const from = async (kind: string, title: string, installations: number) => {
      for (let n = 1; n <= installations; n++) {
        await receive(report({ kind, title, installation: installationId(n) }));
        later(1000);
      }
    };
    await from('idea', 'A lone idea', 1);
    await from('improvement', 'A wanted improvement', 3);
    await from('bug', 'A lone bug', 1);
    await from('bug', 'A wide bug', 3);
    await from('idea', 'A newer lone idea', 1);
    expect((await cards()).map((c: { title: string; priority: string; installations: number }) => [c.title, c.priority, c.installations])).toEqual([
      ['A wide bug', 'high', 3],
      ['A wanted improvement', 'normal', 3],
      ['A lone bug', 'normal', 1],
      ['A newer lone idea', 'low', 1],
      ['A lone idea', 'low', 1],
    ]);
  });

  it('takes 10 reports an hour from one installation, and others meanwhile', async () => {
    const { receive, cards, later } = await inbox();
    const bug = (n: number) => `Bug ${String.fromCharCode(97 + n)}`;
    for (let i = 0; i < 10; i++) expect((await receive(report({ title: bug(i) }))).statusCode).toBe(202);
    const over = await receive(report({ title: bug(10) }));
    expect([over.statusCode, over.headers['retry-after']]).toEqual([429, '3600']);
    expect((await receive(report({ installation: installationId(2), title: bug(10) }))).statusCode).toBe(202);
    later(HOUR);
    expect((await receive(report({ title: bug(11) }))).statusCode).toBe(202);
    expect(await cards()).toHaveLength(12);
  });

  it('opens at most 200 new cards an hour, while repeats still count', async () => {
    const { receive, cards, later } = await inbox();
    for (let i = 0; i < 200; i++) expect((await receive(report({ installation: installationId(i), title: `Bug number ${String.fromCharCode(97 + (i % 26))} ${'x'.repeat(Math.floor(i / 26) + 1)}` }))).statusCode).toBe(202);
    const flood = await receive(report({ installation: installationId(500), title: 'One more new bug' }));
    expect(flood.statusCode).toBe(429);
    expect((await receive(report({ installation: installationId(501), title: 'Bug number a x' }))).statusCode).toBe(202);
    later(HOUR);
    expect((await receive(report({ installation: installationId(500), title: 'One more new bug' }))).statusCode).toBe(202);
    expect(await cards()).toHaveLength(201);
  });

  it("puts what its own people send straight into the list, without hornhoof.org", async () => {
    const { app, ceo, relay, cards } = await inbox();
    const idea = { kind: 'idea', title: 'A map of the whole company', text: 'Mail me at ivan@acme.example' };
    const { digest } = (await app.inject({ method: 'POST', url: '/api/feedback/preview', payload: idea, ...as(ceo) })).json();
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { ...idea, digest }, ...as(ceo) })).statusCode).toBe(200);
    expect(relay.calls).toEqual([]);
    expect(await cards()).toMatchObject([{ kind: 'idea', title: 'A map of the whole company', text: 'Mail me at [email]', signals: 1, installations: 1 }]);
  });
});
