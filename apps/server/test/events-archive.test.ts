import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentEventArchives, agentEvents, agents, companies, departments, jobs, people, subscriptions, turns, type AgentEventKind } from '../src/db/schema.js';
import { FIRST_CONTACT_ACTION } from '../src/modules/conversation/prompt.js';
import { archiveRound, HISTORY_DAYS } from '../src/modules/events/archive.js';
import { earlierTalk } from '../src/modules/events/store.js';
import { backupRound } from '../src/modules/files/backup.js';
import { hideSecretIn, storedTexts } from '../src/modules/tasks/hide-secret.js';
import { as } from './helpers-basic.js';
import { setUpCompany } from './helpers-company.js';
import { testApp } from './helpers.js';

/* The old history of agents leaves the database for the file store (#2126): the text, tool, tool_result and todo events
   of jobs that ended before the company's window, while every message and marker stays, and every reader that showed
   them shows them the same from the archive. Synthetic company and texts only; the rounds run at the times the test names. */

const DAY = 86_400_000;
const NOW = new Date('2026-11-25T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

async function stand() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const dir = mkdtempSync(join(tmpdir(), 'hh-archive-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  app.ctx.config.filesDir = dir;
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const on = { companyId: acme!.id, agentId: agent!.id };
  const [plan] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: owner!.id, status: 'ready' }).returning();
  /* A job that ended at this moment, or one still running. */
  const job = async (ended: Date | null, over: Partial<typeof jobs.$inferInsert> = {}) =>
    (await db.insert(jobs).values({ ...on, subscriptionId: plan!.id, prompt: 'Work', timeoutMs: 60_000, status: ended ? 'done' : 'running', createdAt: new Date((ended ?? NOW).getTime() - 3_600_000), finishedAt: ended, ...over }).returning())[0]!;
  const event = async (jobId: string | null, kind: AgentEventKind, data: Record<string, unknown>, at: Date, personId?: string) =>
    (await db.insert(agentEvents).values({ ...on, jobId, kind, data, personId: personId ?? null, createdAt: at }).returning())[0]!;
  /* An old job's talk: the person's message, what the agent said and did, and the marks the "send once" checks read. */
  const talk = async (ended: Date, texts = ['First answer', 'Second answer']) => {
    const done = await job(ended);
    const at = (n: number) => new Date(ended.getTime() - 3_000_000 + n * 1000);
    const kept = [
      await event(done.id, 'message', { text: 'Please look' }, at(0), owner!.id),
      await event(done.id, 'message', { text: 'Silent', silentJob: done.id }, at(1)),
      await event(done.id, 'typed', { text: 'A delivery', operatorFallback: 'delivery-1' }, at(2)),
      await event(done.id, 'text', { text: 'A failure', failureCase: 'case-1' }, at(3)),
      await event(done.id, 'failed', { error: 'once' }, at(4)),
    ];
    const archived = [
      await event(done.id, 'tool', { name: 'Read', input: { path: 'notes.md' } }, at(5)),
      await event(done.id, 'tool_result', { name: 'Read', output: 'lines' }, at(6)),
      await event(done.id, 'todo', { items: [{ text: 'Check', done: true }] }, at(7)),
      ...(await Promise.all(texts.map((text, n) => event(done.id, 'text', { text }, at(8 + n))))),
    ];
    return { job: done, kept, archived };
  };
  const events = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${agent!.id}/events${query}`, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    return res.json().events as { seq: number; kind: string; data: Record<string, unknown> }[];
  };
  const raw = async () => (await db.select({ id: agentEvents.id }).from(agentEvents).where(eq(agentEvents.agentId, agent!.id))).map(row => row.id);
  const archives = () => db.select().from(agentEventArchives).orderBy(asc(agentEventArchives.createdAt));
  const fileStore = (payload?: object) =>
    app.inject({ method: payload ? 'PATCH' : 'GET', url: '/api/company/file-store', ...(payload ? { payload } : {}), ...as(ceo) });
  return { app, db, ctx: app.ctx, ceo, acme: acme!, owner: owner!, agent: agent!, on, job, event, talk, events, raw, archives, fileStore, round: (at = NOW) => archiveRound(app.ctx, at) };
}

describe('the old history of agents', () => {
  it('moves the text, tool, tool_result and todo events of jobs that ended before the window into the store, and reads them back the same', async () => {
    const s = await stand();
    const old = await s.talk(daysAgo(20), ['One', 'Two', 'Three', 'Four', 'Five']);
    const recent = await s.talk(daysAgo(2));
    const running = await s.job(null);
    const live = await s.event(running.id, 'tool', { name: 'Bash' }, daysAgo(0));
    const all = await s.events('?after=0');
    const last = await s.events('?last=500');
    /* "Earlier" in the agent window: the page before the first event of the recent job, which holds archived events. */
    const earlier = await s.events(`?last=8&before=${recent.kept[0]!.seq}`);
    const catchUp = await earlierTalk(s.db, s.agent.id, 20, s.ctx.files);
    expect(earlier.some(e => e.kind === 'tool_result')).toBe(true);

    const round = await s.round();
    expect(round).toMatchObject({ archived: old.archived.length, cleared: old.archived.length });
    const left = new Set(await s.raw());
    expect(old.archived.filter(e => left.has(e.id))).toEqual([]);
    expect([...old.kept, ...recent.kept, ...recent.archived, live].every(e => left.has(e.id))).toBe(true);
    const [archive] = await s.archives();
    expect(archive).toMatchObject({ companyId: s.acme.id, agentId: s.agent.id, events: old.archived.length, jobIds: [old.job.id] });
    expect([...archive!.eventIds].sort()).toEqual(old.archived.map(e => e.id).sort());
    expect(archive!.clearedAt).not.toBeNull();
    expect(s.ctx.files.store().has(archive!.sha256)).toBe(true);

    expect(await s.events('?after=0')).toEqual(all);
    expect(await s.events('?last=500')).toEqual(last);
    expect(await s.events(`?last=8&before=${recent.kept[0]!.seq}`)).toEqual(earlier);
    expect(await s.events(`?after=${old.kept[0]!.seq}`)).toEqual(all.filter(e => e.seq > old.kept[0]!.seq));
    expect(await s.events(`?last=2&before=${old.archived.at(-1)!.seq}`)).toEqual(all.filter(e => e.seq < old.archived.at(-1)!.seq).slice(-2));
    expect(await earlierTalk(s.db, s.agent.id, 20, s.ctx.files)).toEqual(catchUp);

    /* Nothing is left to move, and the store's backup keeps the archive as it keeps the files rows name. */
    expect(await s.round()).toMatchObject({ archived: 0 });
    await backupRound(s.ctx, NOW);
    expect(rowsOf(await s.db.execute(sql`SELECT 1 FROM net.file_backups WHERE sha256 = ${archive!.sha256}`))).toHaveLength(1);
  });

  it('keeps the events of a job that ended inside the window, or while a turn that is still open ran', async () => {
    const s = await stand();
    const [dept] = await s.db.insert(departments).values({ companyId: s.acme.id, name: 'Development', roleCode: 'DEV' }).returning();
    await s.db.insert(turns).values({ companyId: s.acme.id, departmentId: dept!.id, number: 1, goal: 'Ship', status: 'open', openedAt: daysAgo(30) });
    const inside = await s.talk(daysAgo(10));
    const inTurn = await s.talk(daysAgo(20));
    const before = await s.talk(daysAgo(40));
    expect(await s.round()).toMatchObject({ archived: before.archived.length });
    const left = new Set(await s.raw());
    expect([...inside.archived, ...inTurn.archived].every(e => left.has(e.id))).toBe(true);
    expect(before.archived.filter(e => left.has(e.id))).toEqual([]);
  });

  it('keeps them for the days the CEO sets in Settings, 14 unless set', async () => {
    const s = await stand();
    expect(HISTORY_DAYS).toBe(14);
    expect((await s.fileStore()).json()).toMatchObject({ historyDays: 14 });
    const old = await s.talk(daysAgo(10));
    expect(await s.round()).toMatchObject({ archived: 0 });
    expect((await s.fileStore({ historyDays: 0 })).statusCode).toBe(400);
    const set = await s.fileStore({ historyDays: 7 });
    expect([set.statusCode, set.json().historyDays]).toEqual([200, 7]);
    expect((await s.db.select({ days: companies.historyDays }).from(companies).where(eq(companies.id, s.acme.id)))[0]!.days).toBe(7);
    expect(await s.round()).toMatchObject({ archived: old.archived.length });
  });

  it('leaves everything in the database on a server with no FILES_DIR, whose store goes with a restart', async () => {
    const s = await stand();
    delete s.ctx.config.filesDir;
    const old = await s.talk(daysAgo(20));
    expect(await s.round()).toMatchObject({ archived: 0, stays: 'no_files_dir' });
    const left = new Set(await s.raw());
    expect(old.archived.every(e => left.has(e.id))).toBe(true);
  });

  it('answers a first contact from the archive', async () => {
    const s = await stand();
    const ended = daysAgo(20);
    const contact = await s.job(ended, { kind: 'conversation', createdBy: s.owner.id });
    await s.event(contact.id, 'message', { text: 'Hello', action: FIRST_CONTACT_ACTION }, new Date(ended.getTime() - 60_000), s.owner.id);
    await s.event(contact.id, 'text', { text: 'Welcome to the company' }, new Date(ended.getTime() - 30_000));
    await s.event(contact.id, 'text', { text: 'Here is what I can do' }, new Date(ended.getTime() - 20_000));
    const ask = async () => (await s.app.inject({ method: 'GET', url: '/api/orchestrator/first-contact', ...as(s.ceo) })).json().last;
    const before = await ask();
    expect(before.answer.replies).toEqual(['Welcome to the company', 'Here is what I can do']);
    expect(await s.round()).toMatchObject({ archived: 2 });
    expect(await ask()).toEqual(before);
  });

  it('hides a secret in the archive too, and lets the file that held it go', async () => {
    const s = await stand();
    const secret = 'sk-test-archive-0123456789abcdef';
    await s.talk(daysAgo(20), [`The key is ${secret} for now`]);
    await s.round();
    const [was] = await s.archives();
    await s.db.transaction(tx => hideSecretIn(tx as unknown as typeof s.db, s.acme.id, s.owner.id, secret, storedTexts(s.ctx, tx)));
    const [now] = await s.archives();
    expect(now!.id).toBe(was!.id);
    expect(now!.sha256).not.toBe(was!.sha256);
    const plain = gunzipSync(await s.ctx.files.bytes(s.db, now!.sha256)).toString('utf8');
    expect(plain).not.toContain(secret);
    expect(plain).toContain('The key is');
    const shown = (await s.events('?after=0')).filter(e => e.kind === 'text').map(e => String(e.data.text));
    expect(shown.some(text => text.startsWith('The key is') && !text.includes(secret))).toBe(true);
    const [gone] = rowsOf<{ drop_at: Date | null }>(await s.db.execute(sql`SELECT drop_at FROM net.files WHERE sha256 = ${was!.sha256}`));
    expect(gone?.drop_at ?? null).not.toBeNull();
  });
});
