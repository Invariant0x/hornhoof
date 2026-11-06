import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { computerAccessIntents, people, proposals } from '../src/db/schema.js';
import { questionDisclosure } from '../src/modules/tasks/question-disclosure.js';
import { computerBeforePerson, invitePerson } from './helpers.js';
import { waitCompany } from './wait-company.js';

/* The one check for whoever then seals or hands over what a person reads. Questions of a task are in question-lifecycle.test.ts; this
   is the same check for the two sources that have no task. */

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const envelope = { situation: 'The company needs a design department.', requiredAction: 'Build it or leave it.', options: [] };
const items = [{ template: 'design', checked: true, note: 'Screens for checkout.' }];
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason ?? String(err));

async function company() {
  const c = await waitCompany();
  const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
  const shown = (source: { kind: 'task_request' | 'proposal' | 'computer_access'; id: string }, personId = ceo!.id, expected?: { revision: number; routeRevision: number }, companyId = c.companyId) =>
    c.db.transaction(tx => questionDisclosure(tx, { personId, companyId }, source, expected));
  const stranger = async () => (await c.db.insert(people).values({ companyId: c.companyId, name: 'Zed', email: 'zed@example.test', status: 'active', scopeKind: 'company' }).returning())[0]!.id;
  return { ...c, ceoId: ceo!.id, shown, stranger };
}

describe('what a person is about to read of a card', () => {
  async function aCard(put = true) {
    const c = await company();
    const client = (await c.run(c.orchestrator.id)).client as Client;
    const kept = await call(client, 'propose_structure', { brief: 'A design department for checkout.', items });
    expect(kept.isError, kept.content[0]!.text).toBeFalsy();
    const { id, digest } = JSON.parse(kept.content[0]!.text.slice(kept.content[0]!.text.indexOf('{'))) as { id: string; digest: string };
    if (put) {
      const res = await call(client, 'classify_human_intent', { operationId: randomUUID(), source: { kind: 'proposal', id }, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'ready_result', artifact: { kind: 'structure', digest } }, humanEnvelope: envelope });
      expect(res.isError, res.content[0]!.text).toBeFalsy();
    }
    return { ...c, id, digest, source: { kind: 'proposal' as const, id } };
  }

  it('binds exactly what was put before them, with the card itself', async () => {
    const c = await aCard();
    const [card] = await c.db.select().from(proposals).where(eq(proposals.id, c.id));
    const shown = await c.shown(c.source);
    expect(shown).toMatchObject({
      kind: 'proposal', source: c.source, revision: 1, routeRevision: 1, personId: c.ceoId, companyId: c.companyId,
      classificationId: card!.classification!.classificationId, digest: card!.classification!.digest, materialRevision: 1, materialDigest: c.digest,
      proposal: { id: c.id, status: 'pending' },
    });
    expect(await reason(c.shown(c.source, c.ceoId, { revision: 1, routeRevision: 1 }))).toBe('ok');
  });

  it('is nothing while the card is inside the company', async () => {
    const c = await aCard(false);
    expect(await reason(c.shown(c.source))).toBe('classification_required');
  });

  it('is nothing for someone it was not put before, from another company, or of no card', async () => {
    const c = await aCard();
    expect(await reason(c.shown(c.source, await c.stranger()))).toBe('question_not_allowed');
    expect(await reason(c.shown(c.source, c.ceoId, undefined, randomUUID()))).toBe('request_unknown');
    expect(await reason(c.shown({ kind: 'proposal', id: randomUUID() }))).toBe('request_unknown');
  });

  it('is nothing for what was read before', async () => {
    const c = await aCard();
    expect(await reason(c.shown(c.source, c.ceoId, { revision: 2, routeRevision: 1 }))).toBe('stale_revision');
    expect(await reason(c.shown(c.source, c.ceoId, { revision: 1, routeRevision: 2 }))).toBe('stale_route');
  });

  it('is nothing once the card says something else, or who decides it changed', async () => {
    const c = await aCard();
    await c.db.update(proposals).set({ brief: 'Something else.' }).where(eq(proposals.id, c.id));
    expect(await reason(c.shown(c.source))).toBe('stale_route');
    await c.db.update(proposals).set({ brief: 'A design department for checkout.' }).where(eq(proposals.id, c.id));
    expect(await reason(c.shown(c.source))).toBe('ok');
    await invitePerson(c.app, c.ceo, { name: 'Ada', email: 'ada@example.test', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'ada@example.test'));
    expect(await reason(c.shown(c.source))).toBe('stale_route');
  });

  it('is nothing once the card is over', async () => {
    const c = await aCard();
    await c.db.update(proposals).set({ status: 'dismissed' }).where(eq(proposals.id, c.id));
    expect(await reason(c.shown(c.source))).toBe('source_closed');
  });
});

describe('what a person is about to read of a request for the computer', () => {
  async function aRequest() {
    const c = await company();
    const intent = await computerBeforePerson(c.ctx, 'The server needs a restart that only its computer can do.');
    return { ...c, id: intent.id, source: { kind: 'computer_access' as const, id: intent.id } };
  }

  it('binds exactly what was put before them, and it has no material', async () => {
    const c = await aRequest();
    const [row] = await c.db.select().from(computerAccessIntents).where(eq(computerAccessIntents.id, c.id));
    const shown = await c.shown(c.source);
    expect(shown).toMatchObject({
      kind: 'computer_access', source: c.source, revision: 1, routeRevision: 1, personId: c.ceoId, companyId: c.companyId,
      classificationId: row!.classification!.classificationId, digest: row!.classification!.digest, materialRevision: null, materialDigest: null,
      intent: { id: c.id, status: 'open' },
    });
  });

  it('is nothing while it is inside the company', async () => {
    const c = await aRequest();
    await c.db.update(computerAccessIntents).set({ audience: 'internal', classification: null }).where(eq(computerAccessIntents.id, c.id));
    expect(await reason(c.shown(c.source))).toBe('classification_required');
  });

  it('is nothing for someone it was not put before, from another company, or of no request', async () => {
    const c = await aRequest();
    expect(await reason(c.shown(c.source, await c.stranger()))).toBe('question_not_allowed');
    expect(await reason(c.shown(c.source, c.ceoId, undefined, randomUUID()))).toBe('request_unknown');
    expect(await reason(c.shown({ kind: 'computer_access', id: randomUUID() }))).toBe('request_unknown');
  });

  it('is nothing for what was read before, or once who decides changed', async () => {
    const c = await aRequest();
    expect(await reason(c.shown(c.source, c.ceoId, { revision: 2, routeRevision: 1 }))).toBe('stale_revision');
    await invitePerson(c.app, c.ceo, { name: 'Ada', email: 'ada@example.test', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'ada@example.test'));
    expect(await reason(c.shown(c.source))).toBe('stale_route');
  });

  it('is nothing once it is over', async () => {
    const c = await aRequest();
    await c.db.update(computerAccessIntents).set({ status: 'declined' }).where(eq(computerAccessIntents.id, c.id));
    expect(await reason(c.shown(c.source))).toBe('source_closed');
  });
});
