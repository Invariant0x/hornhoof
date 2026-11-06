import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, jobs, people, proposals } from '../src/db/schema.js';
import { claimQuestions } from '../src/modules/tasks/question-intents.js';
import { as, invitePerson } from './helpers.js';
import { waitCompany } from './wait-company.js';

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const envelope = { situation: 'The company needs a design department.', requiredAction: 'Build it or leave it.', options: [] };
const items = [{ template: 'design', checked: true, note: 'Screens for checkout.' }];

async function company() {
  const c = await waitCompany();
  const orchestrator = await c.run(c.orchestrator.id);
  const client = orchestrator.client as Client;
  const seen = async (token = c.ceo) => (await c.app.inject({ url: '/api/requests', ...as(token) })).json() as { proposals: { id: string; envelope: unknown; purpose: unknown }[]; counts: { total: number } };
  const card = async (id: string) => (await c.db.select().from(proposals).where(eq(proposals.id, id)))[0]!;
  const propose = async () => {
    const res = await call(client, 'propose_structure', { brief: 'A design department for checkout.', items });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const [{ id, digest }] = [JSON.parse(res.content[0]!.text.slice(res.content[0]!.text.indexOf('{'))) as { id: string; digest: string }];
    return { id, digest };
  };
  const guard = (id: string, more: Record<string, unknown> = {}) => ({ operationId: randomUUID(), source: { kind: 'proposal', id }, expectedRevision: 1, expectedRouteRevision: 1, ...more });
  const classify = (id: string, digest: string, more: Record<string, unknown> = {}) => call(client, 'classify_human_intent', { ...guard(id), classification: { kind: 'ready_result', artifact: { kind: 'structure', digest } }, humanEnvelope: envelope, ...more });
  const build = (id: string | undefined, token = c.ceo) => c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { ...(id ? { proposalId: id } : {}), items }, ...as(token) });
  const events = () => c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'proposal')));
  const turns = () => c.db.select().from(jobs).where(eq(jobs.agentId, c.orchestrator.id));
  return { ...c, client, seen, card, propose, guard, classify, build, events, turns };
}

describe('a card of the orchestrator', () => {
  it('starts inside the company: no person is shown it, nothing of it is in its window, and it wakes nobody', async () => {
    const c = await company();
    const before = (await c.turns()).length;
    const { id } = await c.propose();
    expect(await c.card(id)).toMatchObject({ audience: 'internal', triageAgentId: c.orchestrator.id, questionRevision: 1, routeRevision: 1, sourceKey: `proposal:${id}`, status: 'pending', classification: null });
    expect(await c.seen()).toMatchObject({ proposals: [], counts: { total: 0 } });
    expect(await c.events()).toEqual([]);
    expect(await c.turns()).toHaveLength(before);
  });

  it('comes before a person in the same turn, once its own digest is named, with everything it rests on', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    const res = await c.classify(id, digest);
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ source: { kind: 'proposal', id }, audience: 'human', revision: 1, routeRevision: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const seen = await c.seen();
    expect(seen.counts.total).toBe(1);
    expect(seen.proposals).toMatchObject([{ id, envelope, purpose: { kind: 'decision', decisionKind: 'structure' } }]);
    expect((await c.card(id)).classification).toMatchObject({
      source: { kind: 'proposal', id }, revision: 1, routeRevision: 1, materialRevision: 1, materialDigest: digest,
      sourceBinding: { companyId: c.companyId, authorAgentId: c.orchestrator.id, taskAssignment: null },
      authority: { purpose: { kind: 'decision', decisionKind: 'structure' } },
    });
    const events = await c.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ proposalId: id, brief: 'A design department for checkout.', items, question: { transition: 'classified' } });
  });

  it('takes nothing but its own digest and kind, and no action of a person', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    expect((await c.classify(id, 'a'.repeat(64))).isError).toBe(true);
    expect((await c.classify(id, digest, { classification: { kind: 'ready_result', artifact: { kind: 'staff', digest } } })).isError).toBe(true);
    expect((await c.classify(id, digest, { classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: 'a'.repeat(40) } } })).isError).toBe(true);
    expect((await c.classify(id, digest, { classification: { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: c.sub.id } } })).isError).toBe(true);
    expect((await c.card(id)).audience).toBe('internal');
    expect((await c.seen()).counts.total).toBe(0);
  });

  it('is put before a person by nobody but the orchestrator', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    const head = await c.run(c.head.id);
    const res = await call(head.client as Client, 'classify_human_intent', { ...c.guard(id), classification: { kind: 'ready_result', artifact: { kind: 'structure', digest } }, humanEnvelope: envelope });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not yours');
    expect((await c.card(id)).audience).toBe('internal');
  });

  it('gives what was done on the same operation again, and refuses another input under it, and what was read before', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    const operationId = randomUUID();
    const input = { ...c.guard(id), operationId, classification: { kind: 'ready_result', artifact: { kind: 'structure', digest } }, humanEnvelope: envelope };
    const first = await call(c.client, 'classify_human_intent', input);
    const again = await call(c.client, 'classify_human_intent', input);
    expect(JSON.parse(again.content[0]!.text)).toEqual(JSON.parse(first.content[0]!.text));
    expect(await c.events()).toHaveLength(1);
    const changed = await call(c.client, 'classify_human_intent', { ...input, humanEnvelope: { ...envelope, situation: 'Something else now.' } });
    expect(changed.content[0]!.text).toContain('operation_conflict');
    const stale = await c.classify(id, digest, { expectedRevision: 2 });
    expect(stale.content[0]!.text).toContain('stale_revision');
  });

  it('closes when a newer one comes, and what was said of it never goes for the newer', async () => {
    const c = await company();
    const old = await c.propose();
    await c.classify(old.id, old.digest);
    const newer = await c.propose();
    expect(await c.card(old.id)).toMatchObject({ status: 'dismissed' });
    expect(await c.card(newer.id)).toMatchObject({ audience: 'internal', status: 'pending', classification: null });
    expect((await c.seen()).proposals).toEqual([]);
    expect((await c.classify(old.id, old.digest)).content[0]!.text).toContain('source_closed');
    expect((await c.build(old.id)).json().error.reason).toBe('proposal_closed');
    expect((await c.build(newer.id)).json().error.reason).toBe('classification_required');
    expect((await c.card(newer.id)).status).toBe('pending');
  });

  it('cannot be applied over HTTP while it is inside; a person building without a card still can', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    const refused = await c.build(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('classification_required');
    expect((await c.card(id)).status).toBe('pending');
    await c.classify(id, digest);
    const built = await c.build(id);
    expect(built.statusCode, built.body).toBe(201);
    expect(await c.card(id)).toMatchObject({ status: 'applied' });
    const native = await c.build(undefined);
    expect(native.statusCode, native.body).not.toBe(409);
  });

  it('goes back inside when who decides changed, and a person cannot take it until it is put there again', async () => {
    const c = await company();
    const { id, digest } = await c.propose();
    await c.classify(id, digest);
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.test', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'zed@example.test'));
    const stale = await c.build(id);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.reason).toBe('stale_route');
    expect(await c.card(id)).toMatchObject({ audience: 'internal', classification: null, routeRevision: 2, status: 'pending' });
    expect((await c.seen()).proposals).toEqual([]);
    expect((await c.classify(id, digest, { expectedRouteRevision: 2 })).isError).toBeFalsy();
  });

  it('left from before is picked up by the orchestrator once, and its words stay inside until then', async () => {
    const c = await company();
    const [card] = await c.db.insert(proposals).values({ companyId: c.companyId, agentId: c.orchestrator.id, brief: 'Old one.', items, sourceKey: 'legacy:proposal:x' }).returning();
    const before = (await c.turns()).length;
    await claimQuestions(c.ctx);
    await claimQuestions(c.ctx);
    expect(await c.card(card!.id)).toMatchObject({ audience: 'internal', triageAgentId: c.orchestrator.id, routeRevision: 2, status: 'pending' });
    expect((await c.seen()).proposals).toEqual([]);
    const listed = JSON.parse((await call(c.client, 'internal_questions', {})).content[0]!.text);
    expect(listed.cards).toMatchObject([{ source: { kind: 'proposal', id: card!.id }, kind: 'structure', brief: 'Old one.', revision: 1, routeRevision: 2, digest: expect.any(String) }]);
    expect(await c.events()).toEqual([]);
    expect((await c.turns()).length + (await c.messages(c.orchestrator.id)).length).toBeGreaterThan(before);
  });

  it('is listed to the orchestrator only', async () => {
    const c = await company();
    await c.propose();
    const head = await c.run(c.head.id);
    expect(JSON.parse((await call(head.client as Client, 'internal_questions', {})).content[0]!.text).cards).toEqual([]);
    expect(JSON.parse((await call(c.client, 'internal_questions', {})).content[0]!.text).cards).toHaveLength(1);
  });

  it('is put aside by the orchestrator, for good', async () => {
    const c = await company();
    const { id } = await c.propose();
    const res = await call(c.client, 'resolve_question', { ...c.guard(id), resolution: 'Not needed after all.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(await c.card(id)).toMatchObject({ status: 'dismissed' });
    const [closed] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(closed!.data).toMatchObject({ proposalId: id, question: { transition: 'resolved' } });
  });
});

describe('a staff card', () => {
  const lines = [{ role: 'DEV-QA', name: 'Quinn', checked: true }];

  async function staffCard() {
    const c = await company();
    const hireLine = { role: 'DEV-QA', name: 'Quinn', model: '', skills: c.ctx.templates.roles.get('DEV-QA')!.skills.filter(s => s.on).map(s => s.id) };
    const res = await call(c.client, 'propose_staff', { department: c.dev.id, brief: 'A tester.', people: lines });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const { id, digest } = JSON.parse(res.content[0]!.text.slice(res.content[0]!.text.indexOf('{'))) as { id: string; digest: string };
    const classify = () => call(c.client, 'classify_human_intent', { ...c.guard(id), classification: { kind: 'ready_result', artifact: { kind: 'staff', digest } }, humanEnvelope: { situation: 'The department needs a tester.', requiredAction: 'Hire them or leave it.', options: [] } });
    const hire = (lines: unknown[], token = c.ceo) => c.app.inject({ method: 'POST', url: `/api/departments/${c.dev.id}/staff`, payload: { proposalId: id, people: lines }, ...as(token) });
    const applied = () => c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    return { ...c, id, digest, classify, hire, applied, hireLine };
  }

  it('cannot be hired from while it is inside', async () => {
    const c = await staffCard();
    const res = await c.hire([{ ...c.hireLine, subscription: c.sub.id }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('classification_required');
  });

  it('records what the person decided, as they decided it, when they changed it on the card', async () => {
    const c = await staffCard();
    await c.classify();
    const res = await c.hire([{ ...c.hireLine, name: 'Quentin', subscription: c.sub.id }]);
    expect(res.statusCode, res.body).toBe(201);
    const [applied] = await c.applied();
    expect(applied!.data).toMatchObject({ proposalId: c.id, decision: { cardDigest: c.digest, edited: true, decided: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it('says it was not changed when it was not', async () => {
    const c = await staffCard();
    await c.classify();
    const res = await c.hire([{ ...c.hireLine, subscription: c.sub.id }]);
    expect(res.statusCode, res.body).toBe(201);
    const [applied] = await c.applied();
    expect(applied!.data).toMatchObject({ decision: { cardDigest: c.digest, edited: false } });
  });
});
