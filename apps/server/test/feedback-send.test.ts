import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, improvements, machines, people } from '../src/db/schema.js';
import { fakeRelay } from './fake-relay.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { as, invitePerson, setUpCompany, TEST_SECRET, testApp } from './helpers.js';

/* An installation of some company sends a bug, an improvement or an idea to Hornhoof's developers through hornhoof.org:
   the person sees what goes, the technical data with it, and nothing leaves until they press send. */

async function installation(env: NodeJS.ProcessEnv = {}) {
  const relay = await fakeRelay();
  const { app, db, config } = await testApp({ RELAY_URL: relay.url, ...env });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [ivan] = await db.select().from(people);
  /* Two machines of the company and one taken back, whose names stay at home. */
  await db.insert(machines).values([
    { companyId: acme!.id, personId: ivan!.id, machineKey: 'm1', hostname: 'dev-laptop.acme.test', os: 'linux', arch: 'x64' },
    { companyId: acme!.id, personId: ivan!.id, machineKey: 'm2', hostname: 'build-mac', os: 'darwin', arch: 'arm64' },
    { companyId: acme!.id, personId: ivan!.id, machineKey: 'm3', hostname: 'old', os: 'windows', arch: 'x64', revokedAt: new Date('2026-11-01T00:00:00Z') },
  ]);
  let now = Date.parse('2026-11-12T12:00:00Z');
  app.ctx.clock = () => now;
  const later = (ms: number) => (now += ms);
  const preview = (payload: object, token = ceo) => app.inject({ method: 'POST', url: '/api/feedback/preview', payload, ...as(token) });
  const send = (payload: object, token = ceo) => app.inject({ method: 'POST', url: '/api/feedback', payload, ...as(token) });
  return { app, db, config, relay, ceo, acme: acme!, ivan: ivan!, preview, send, later };
}

/* A finding of an agent of the company, as propose_improvement keeps it. */
async function finding(db: Awaited<ReturnType<typeof installation>>['db'], companyId: string, values: Partial<typeof improvements.$inferInsert> = {}) {
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const [row] = await db
    .insert(improvements)
    .values({ companyId, agentId: agent!.id, title: 'The terminal of an agent closes after an update', text: 'Change: keep the terminal through an update.', scope: 'platform', code: 'terminal_lost', ...values })
    .returning();
  return row!;
}

const BUG = { kind: 'bug', title: 'Terminal froze for alex@acme.example', text: 'In /home/alex/shop the key ghp_0123456789abcdefghijABCDEFGHIJ012345 showed, then nothing.' };

describe('sending feedback to Hornhoof developers', () => {
  it('shows exactly what would go and sends exactly that once the person presses send', async () => {
    const { app, config, relay, ceo, preview, send } = await installation();
    expect((await app.inject({ url: '/api/feedback', ...as(ceo) })).json()).toEqual({ inbox: false });
    const shown = await preview(BUG);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      report: {
        kind: 'bug',
        title: 'Terminal froze for [email]',
        text: 'In [path] the key [secret] showed, then nothing.',
        facts: { version: config.version, platform: ['darwin arm64', 'linux x64'], errorCode: null },
      },
      hidden: { secret: 1, email: 1, address: 0, path: 1 },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    /* Looking at it sends nothing. */
    expect(relay.calls).toEqual([]);
    const sent = await send({ ...BUG, digest: shown.json().digest });
    expect([sent.statusCode, sent.json()]).toEqual([200, { sent: true }]);
    expect(relay.calls).toEqual(['POST /api/v1/feedback']);
    expect(relay.feedback).toEqual([{ v: 1, installation: expect.stringMatching(/^[0-9a-f]{32}$/), submission: expect.stringMatching(/^[0-9a-f]{64}$/), ...shown.json().report }]);
  });

  it('refuses to send what the person did not see', async () => {
    const { db, acme, ivan, relay, preview, send } = await installation();
    const { digest } = (await preview(BUG)).json();
    const other = await send({ ...BUG, text: 'Something else.', digest });
    expect([other.statusCode, other.json().error.reason]).toEqual([409, 'feedback_changed']);
    /* A machine joined after the person looked: the technical data is not what they saw. */
    await db.insert(machines).values({ companyId: acme.id, personId: ivan.id, machineKey: 'm4', hostname: 'new', os: 'linux', arch: 'arm64' });
    const moved = await send({ ...BUG, digest });
    expect([moved.statusCode, moved.json().error.reason]).toEqual([409, 'feedback_changed']);
    expect((await send(BUG)).statusCode).toBe(400);
    expect(relay.calls).toEqual([]);
  });

  it('is for people signed in, never for an agent or anyone without a session', async () => {
    const { app, relay } = await installation();
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { ...BUG, digest: '0'.repeat(64) } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { ...BUG, digest: '0'.repeat(64) }, headers: { authorization: 'Bearer tool-token-0123456789abcdef0123' } })).statusCode).toBe(401);
    expect(relay.calls).toEqual([]);
  });

  it('sends what the orchestrator saw for the owner, with its digest', async () => {
    const { app, db, ivan, relay, preview } = await installation();
    const { digest } = (await preview(BUG)).json();
    const [agent] = await db.select().from(agents);
    const sent = await app.inject({ method: 'POST', url: '/api/feedback', payload: { ...BUG, digest }, headers: orchestratorHeaders(ivan.id, agent!.id) });
    expect([sent.statusCode, sent.json()]).toEqual([200, { sent: true }]);
    expect(relay.calls).toEqual(['POST /api/v1/feedback']);
  });

  it('lets anyone in the company send, not only who sees all of it', async () => {
    const { app, db, acme, ceo, relay, preview, send } = await installation();
    const [dev] = await db.insert(departments).values({ companyId: acme.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev!.id] } });
    const idea = { kind: 'idea', title: 'Dark map', text: '' };
    const { digest } = (await preview(idea, dana)).json();
    expect((await send({ ...idea, digest }, dana)).statusCode).toBe(200);
    expect(relay.feedback).toHaveLength(1);
  });

  it('checks the kind, the title and the length of what is written', async () => {
    const { preview } = await installation();
    expect((await preview({ ...BUG, kind: 'complaint' })).statusCode).toBe(400);
    expect((await preview({ ...BUG, title: '   ' })).statusCode).toBe(400);
    /* Marks a screen drops leave nothing to show, so a title of them alone is as empty as one of spaces. */
    expect((await preview({ ...BUG, title: '\u200e \u202e\u0007' })).statusCode).toBe(400);
    expect((await preview({ ...BUG, title: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await preview({ ...BUG, text: 'x'.repeat(5001) })).statusCode).toBe(400);
    expect((await preview({ ...BUG, title: 'x'.repeat(200), text: 'x'.repeat(5000) })).statusCode).toBe(200);
  });

  it('signs every report with the same installation id, which tells nothing of the secret', async () => {
    const { relay, preview, send } = await installation();
    for (const title of ['One', 'Two']) {
      const report = { kind: 'idea', title, text: '' };
      await send({ ...report, digest: (await preview(report)).json().digest });
    }
    const [first, second] = relay.feedback as { installation: string }[];
    expect(first!.installation).toBe(second!.installation);
    expect(first!.installation).not.toContain(Buffer.from(TEST_SECRET, 'base64').toString('hex').slice(0, 8));
  });

  it('sends a finding about Hornhoof itself from its card with its error code, and marks it sent', async () => {
    const { db, acme, ivan, relay, preview, send } = await installation();
    const found = await finding(db, acme.id);
    const report = { kind: 'bug', title: found.title, text: found.text, improvement: found.id };
    const shown = (await preview(report)).json();
    expect(shown.report.facts.errorCode).toBe('terminal_lost');
    expect((await send({ ...report, digest: shown.digest })).statusCode).toBe(200);
    expect(relay.feedback).toEqual([expect.objectContaining({ kind: 'bug', title: found.title, facts: expect.objectContaining({ errorCode: 'terminal_lost' }) })]);
    const [row] = await db.select().from(improvements).where(eq(improvements.id, found.id));
    expect(row).toMatchObject({ status: 'sent', decidedBy: ivan.id });
    const again = await send({ ...report, digest: shown.digest });
    expect([again.statusCode, again.json().error.reason]).toEqual([409, 'improvement_decided']);
    expect(relay.feedback).toHaveLength(1);
  });

  it("does not send a finding about the company's own work", async () => {
    const { db, acme, relay, preview } = await installation();
    const own = await finding(db, acme.id, { scope: 'company', code: null });
    const refused = await preview({ kind: 'improvement', title: own.title, text: own.text, improvement: own.id });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([409, 'improvement_not_platform']);
    expect(relay.calls).toEqual([]);
  });

  it('says hornhoof.org does not answer and keeps the finding open when the relay is down', async () => {
    const { db, acme, relay, preview, send } = await installation();
    const found = await finding(db, acme.id);
    const report = { kind: 'bug', title: found.title, text: found.text, improvement: found.id };
    const { digest } = (await preview(report)).json();
    relay.down = true;
    const failed = await send({ ...report, digest });
    expect([failed.statusCode, failed.json().error.reason]).toEqual([503, 'relay_unreachable']);
    expect((await db.select().from(improvements).where(eq(improvements.id, found.id)))[0]!.status).toBe('open');
  });

  it('passes on the wait hornhoof.org asks for when it gets too many', async () => {
    const { relay, preview, send } = await installation();
    const { digest } = (await preview(BUG)).json();
    relay.feedbackAnswer = { status: 429, headers: { 'retry-after': '120' } };
    const busy = await send({ ...BUG, digest });
    expect([busy.statusCode, busy.headers['retry-after']]).toEqual([429, '120']);
  });

  it('lets one person send distinct reports without an hourly cap or resending a retry', async () => {
    const { relay, preview, send } = await installation();
    const payload = async (i: number) => {
      const report = { kind: 'idea', title: `Idea ${i}`, text: '' };
      return { ...report, digest: (await preview(report)).json().digest };
    };
    for (let i = 0; i < 12; i++) expect((await send(await payload(i))).statusCode).toBe(200);
    expect((await send(await payload(0))).statusCode).toBe(200);
    expect(relay.feedback).toHaveLength(12);
  });
});
