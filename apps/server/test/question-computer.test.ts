import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, computerAccessIntents, jobs, people, subscriptions } from '../src/db/schema.js';
import { claimQuestions } from '../src/modules/tasks/question-intents.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

const TOKEN = 'tool-token-0123456789abcdef0123456789';
type Res = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const REASON = 'Restart docker on the box with sudo systemctl.';
const envelope = { situation: 'The server needs a restart that only its computer can do.', requiredAction: 'Open access to that computer for a day, or say no.', options: [] };
const ceoAccess = { kind: 'human_only_action', actionBinding: { kind: 'ceo_permission', resourceId: 'server' } };

async function company() {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  writeFileSync(join(control, 'alive'), '');
  const { app, db } = await testApp({ HORNHOOF_CONTROL_DIR: control });
  const ceo = await setUpCompany(app);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [job] = await db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN), startedAt: new Date() }).returning();
  await listen(app);
  const client = await mcp(app, TOKEN);
  const ctx = app.ctx;
  const file = () => JSON.parse(readFileSync(join(control, 'computer.json'), 'utf8')) as { until: string | null; untilSec: number | null; asked: unknown; controlRevision: number };
  const ask = async () => {
    const res = await call(client, 'ask_computer_access', { reason: REASON });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    return (JSON.parse(res.content[0]!.text.slice(res.content[0]!.text.indexOf('{'))) as { id: string }).id;
  };
  const guard = (id: string, more: Record<string, unknown> = {}) => ({ operationId: randomUUID(), source: { kind: 'computer_access', id }, expectedRevision: 1, expectedRouteRevision: 1, ...more });
  const classify = (id: string, more: Record<string, unknown> = {}) => call(client, 'classify_human_intent', { ...guard(id), classification: ceoAccess, humanEnvelope: envelope, ...more });
  const intent = async (id: string) => (await db.select().from(computerAccessIntents).where(eq(computerAccessIntents.id, id)))[0]!;
  const seen = async () => (await app.inject({ url: '/api/requests', ...as(ceo) })).json() as { computerAccess: { envelope: unknown; purpose: unknown; view: { asked: { reason: string } | null } } | null; counts: { total: number } };
  const computer = async () => (await app.inject({ url: '/api/computer', ...as(ceo) })).json() as { asked: { reason: string } | null; until: string | null };
  const click = (what: 'open' | 'close' | 'decline', token = ceo) => app.inject({ method: 'POST', url: `/api/computer/${what}`, ...as(token) });
  const lines = async () => (await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, orchestrator!.id), eq(agentEvents.kind, 'computer')))).map(e => e.data as { state: string; reason?: string; until?: string });
  const turns = () => db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator!.id), eq(jobs.status, 'queued')));
  /* What a crash leaves: the operation written down, the file as it happens to be. */
  const reserved = async (id: string, operationId = randomUUID()) => {
    const row = await intent(id);
    const target = new Date(Date.parse(row.classification!.authority.purpose.kind === 'ceo_permission' ? row.classification!.authority.purpose.until : ''));
    await db.update(computerAccessIntents).set({ status: 'apply_unknown', applyOperationId: operationId, applyRevision: row.questionRevision, applyRouteRevision: row.routeRevision, applyControlRevision: ctx.computer.control().revision, applyTargetUntil: target, updatedAt: new Date(Date.now() - 120_000) }).where(eq(computerAccessIntents.id, id));
    return { operationId, target };
  };
  return { app, db, ctx, ceo, control, orchestrator: orchestrator!, job: job!, client, file, ask, guard, classify, intent, seen, computer, click, lines, turns, reserved };
}

describe('asking for the computer', () => {
  it('starts inside the company: no person sees it, nothing of it is in the file or the window, and it wakes nobody', async () => {
    const c = await company();
    const id = await c.ask();
    expect(await c.intent(id)).toMatchObject({ audience: 'internal', status: 'open', technicalText: REASON, triageAgentId: c.orchestrator.id, sourceJobId: c.job.id, sourceKey: `computer_access:${id}`, classification: null });
    expect(await c.seen()).toMatchObject({ computerAccess: null, counts: { total: 0 } });
    expect((await c.computer()).asked).toBeNull();
    expect(await c.lines()).toEqual([]);
    expect(await c.turns()).toEqual([]);
  });

  it('comes before the CEO once said to be what only they can do, in plain words, for a day it names', async () => {
    const c = await company();
    const id = await c.ask();
    const res = await c.classify(id);
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ source: { kind: 'computer_access', id }, audience: 'human', revision: 1, routeRevision: 1 });
    const row = await c.intent(id);
    expect(row.classification).toMatchObject({ source: { kind: 'computer_access', id }, sourceBinding: { taskAssignment: null, authorAgentId: c.orchestrator.id }, materialRevision: null, authority: { purpose: { kind: 'ceo_permission', resourceId: 'server', permission: 'server_computer_access' } } });
    const seen = await c.seen();
    expect(seen.counts.total).toBe(1);
    expect(seen.computerAccess).toMatchObject({ envelope, purpose: { kind: 'ceo_permission', permission: 'server_computer_access', until: expect.any(String) } });
    expect(JSON.stringify(seen)).not.toContain('sudo');
    const asked = (await c.computer()).asked!;
    expect(asked.reason).toContain('only its computer can do');
    expect(JSON.stringify(await c.lines())).not.toContain('sudo');
    expect(await c.lines()).toMatchObject([{ state: 'asked' }]);
  });

  it('is nothing else: no ready result, no other action, no other resource', async () => {
    const c = await company();
    const id = await c.ask();
    expect((await c.classify(id, { classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: 'a'.repeat(40) } } })).isError).toBe(true);
    expect((await c.classify(id, { classification: { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: 'server' } } })).isError).toBe(true);
    expect((await c.classify(id, { classification: { kind: 'human_only_action', actionBinding: { kind: 'ceo_permission', resourceId: 'another' } } })).isError).toBe(true);
    expect((await c.intent(id)).audience).toBe('internal');
  });

  it('gives what was done on the same operation again, and refuses another input under it', async () => {
    const c = await company();
    const id = await c.ask();
    const input = { ...c.guard(id), classification: ceoAccess, humanEnvelope: envelope };
    const first = await call(c.client, 'classify_human_intent', input);
    const again = await call(c.client, 'classify_human_intent', input);
    expect(JSON.parse(again.content[0]!.text)).toEqual(JSON.parse(first.content[0]!.text));
    expect(await c.lines()).toHaveLength(1);
    const changed = await call(c.client, 'classify_human_intent', { ...input, humanEnvelope: { ...envelope, situation: 'Something else now.' } });
    expect(changed.content[0]!.text).toContain('operation_conflict');
  });

  it('is settled inside by the one who asked, with no access and no person', async () => {
    const c = await company();
    const id = await c.ask();
    const res = await call(c.client, 'resolve_question', { ...c.guard(id), resolution: 'Not needed after all.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(await c.intent(id)).toMatchObject({ status: 'resolved_internal', resolvedByAgentId: c.orchestrator.id, resolvedByJobId: c.job.id });
    expect((await c.computer()).until).toBeNull();
    expect((await c.seen()).computerAccess).toBeNull();
  });

  it('asked again leaves only the newer', async () => {
    const c = await company();
    const old = await c.ask();
    await c.classify(old);
    const newer = await c.ask();
    expect(await c.intent(old)).toMatchObject({ status: 'withdrawn' });
    expect((await c.seen()).computerAccess).toBeNull();
    expect((await c.classify(old)).content[0]!.text).toContain('source_closed');
    expect(await c.intent(newer)).toMatchObject({ status: 'open', audience: 'internal' });
  });

  it('is listed to the orchestrator with its own words', async () => {
    const c = await company();
    const id = await c.ask();
    const listed = JSON.parse((await call(c.client, 'internal_questions', {})).content[0]!.text);
    expect(listed.access).toMatchObject([{ source: { kind: 'computer_access', id }, text: REASON, revision: 1, routeRevision: 1 }]);
  });
});

describe('a person opening it', () => {
  it('grants exactly what was put before them, written down first and read back, and the orchestrator goes on once', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    const until = ((await c.intent(id)).classification!.authority.purpose as { until: string }).until;
    const res = await c.click('open');
    expect(res.statusCode, res.body).toBe(200);
    const row = await c.intent(id);
    expect(row).toMatchObject({ status: 'granted', applyRevision: 1, applyRouteRevision: 1, applyOperationId: expect.any(String), appliedAt: expect.any(Date) });
    expect(row.applyTargetUntil!.toISOString()).toBe(until);
    expect(c.file().until).toBe(until);
    expect((await c.lines()).map(l => l.state)).toEqual(['asked', 'opened']);
    const turns = await c.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain(REASON);
    expect((await c.seen()).computerAccess).toBeNull();
  });

  it('with nothing asked, or only what is inside, is their own: nothing is answered and nobody goes on', async () => {
    const c = await company();
    const id = await c.ask();
    const res = await c.click('open');
    expect(res.statusCode, res.body).toBe(200);
    expect(c.file().until).not.toBeNull();
    expect(await c.intent(id)).toMatchObject({ status: 'open', audience: 'internal', applyOperationId: null });
    expect(await c.turns()).toEqual([]);
  });

  it('is refused once who decides changed, and it goes back inside', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.test', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'zed@example.test'));
    const res = await c.click('open');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('stale_route');
    expect(await c.intent(id)).toMatchObject({ audience: 'internal', status: 'open', classification: null, routeRevision: 2, applyOperationId: null });
    expect((await c.computer()).until).toBeNull();
    expect((await c.seen()).computerAccess).toBeNull();
  });

  it('declined ends it with nothing opened, by the person who did', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    expect((await c.click('decline')).statusCode).toBe(200);
    expect(await c.intent(id)).toMatchObject({ status: 'declined', applyOperationId: null, appliedAt: null });
    expect((await c.computer()).until).toBeNull();
    expect((await c.lines()).map(l => l.state)).toEqual(['asked', 'declined']);
    expect((await c.seen()).computerAccess).toBeNull();
  });
});

describe('what a crash leaves', () => {
  it('that was applied is granted by the same operation, with no new date and nobody woken', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    const { operationId, target } = await c.reserved(id);
    expect(c.ctx.computer.applyGrant({ operationId, fence: c.ctx.computer.control().revision, until: target })).toBe('applied');
    await claimQuestions(c.ctx);
    expect(await c.intent(id)).toMatchObject({ status: 'granted', appliedAt: expect.any(Date) });
    expect(c.file().until).toBe(target.toISOString());
    expect(await c.turns()).toEqual([]);
  });

  it('that never ran is no grant, and it is not run again', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    await c.reserved(id);
    await claimQuestions(c.ctx);
    expect(await c.intent(id)).toMatchObject({ status: 'withdrawn', appliedAt: null, applyOperationId: expect.any(String) });
    expect((await c.computer()).until).toBeNull();
    expect(await c.turns()).toEqual([]);
  });

  it('gives way to a person who closed it later', async () => {
    const c = await company();
    const id = await c.ask();
    await c.classify(id);
    const { operationId, target } = await c.reserved(id);
    expect(c.ctx.computer.applyGrant({ operationId, fence: c.ctx.computer.control().revision, until: target })).toBe('applied');
    await c.click('close');
    await claimQuestions(c.ctx);
    expect(await c.intent(id)).toMatchObject({ status: 'withdrawn', appliedAt: null });
    expect((await c.computer()).until).toBeNull();
  });
});

describe('the control file', () => {
  it('moves its revision on every open and close, a repeated close too', async () => {
    const c = await company();
    const start = c.ctx.computer.control().revision;
    await c.click('close');
    await c.click('close');
    await c.click('open');
    expect(c.ctx.computer.control().revision).toBe(start + 3);
  });

  it('refuses an operation fenced by a later open or close, and leaves what they did', async () => {
    const c = await company();
    const fence = c.ctx.computer.control().revision;
    await c.click('close');
    expect(c.ctx.computer.applyGrant({ operationId: randomUUID(), fence, until: new Date(Date.now() + 3_600_000) })).toBe('fenced');
    expect(c.file().until).toBeNull();
  });

  it('applies one operation once, however many times it is tried', async () => {
    const c = await company();
    const operationId = randomUUID();
    const until = new Date(Date.now() + 3_600_000);
    const fence = c.ctx.computer.control().revision;
    expect(c.ctx.computer.applyGrant({ operationId, fence, until })).toBe('applied');
    const after = c.ctx.computer.control().revision;
    expect(c.ctx.computer.applyGrant({ operationId, fence, until })).toBe('applied');
    expect(c.ctx.computer.control().revision).toBe(after);
  });
});

describe('a request kept in the file from before', () => {
  it('goes inside once, opens nothing, and people no longer see it', async () => {
    const c = await company();
    writeFileSync(join(c.control, 'computer.json'), JSON.stringify({ untilSec: null, until: null, asked: { reason: 'Free disk space.', at: '2026-11-01T10:00:00.000Z' } }));
    await claimQuestions(c.ctx);
    await claimQuestions(c.ctx);
    const rows = await c.db.select().from(computerAccessIntents);
    expect(rows).toMatchObject([{ audience: 'internal', status: 'open', technicalText: 'Free disk space.', sourceKey: 'legacy:computer_access:2026-11-01T10:00:00.000Z', triageAgentId: c.orchestrator.id }]);
    expect(c.file()).toMatchObject({ asked: null, until: null });
    expect((await c.computer()).asked).toBeNull();
    expect((await c.seen()).computerAccess).toBeNull();
  });
});
