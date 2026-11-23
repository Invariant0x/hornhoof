import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { appendEvent, listEvents } from '../src/modules/events/store.js';
import { agentParty, personParty } from '../src/modules/events/parties.js';
import { setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [person] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (kind: 'head' | 'worker', name: string, roleKey: string) => (await db.insert(agents).values({ companyId: acme!.id, departmentId: dev!.id, subscriptionId: sub!.id, kind, name, roleKey, model: '' }).returning())[0]!;
  const head = await hire('head', 'Hana', 'DEV-HEAD');
  const worker = await hire('worker', 'Bruno', 'DEV-BE');
  return { app, db, companyId: acme!.id, person: person!, orchestrator: orchestrator!, dev: dev!, head, worker };
}

describe('message participants', () => {
  it('keeps the person and role, and the actual recipient, in every agent window after a round trip', async () => {
    const { app, db, companyId, person, orchestrator, head, worker } = await company();
    for (const target of [orchestrator, head, worker]) {
      const event = await appendEvent(app.ctx, { companyId, agentId: target.id, kind: 'message', personId: person.id, data: { text: 'Hornhoof: this is still a person speaking.' } });
      expect(event.message).toMatchObject({ direction: 'in', from: { kind: 'person', id: person.id, name: 'Ivan', role: { en: 'CEO', ru: 'CEO' } }, to: { kind: 'agent', id: target.id, agentKind: target.kind } });
      await db.update(people).set({ name: 'Ivan renamed', title: 'Owner' }).where(eq(people.id, person.id));
      const [loaded] = await listEvents(db, target.id, event.seq - 1);
      expect(loaded!.message).toEqual(event.message);
      expect(loaded!.data).toEqual({ text: 'Hornhoof: this is still a person speaking.' });
      await db.update(people).set({ name: 'Ivan', title: 'CEO' }).where(eq(people.id, person.id));
    }
  });

  it('identifies a head by its stored id, role and department, and identifies Hornhoof notices', async () => {
    const { app, companyId, dev, head, worker } = await company();
    const letter = await appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'message', data: { text: 'Run the focused checks.', from: 'agent', by: head.id, name: head.name } });
    expect(letter.message).toMatchObject({ from: { kind: 'agent', id: head.id, name: 'Hana', agentKind: 'head', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: { id: dev.id, name: { en: 'Development' }, templateKey: 'development' } }, to: { id: worker.id } });
    const notice = await appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'message', data: { text: 'A task is yours to do.' } });
    expect(notice.message).toMatchObject({ direction: 'in', from: { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null }, to: { kind: 'agent', id: worker.id, role: { en: 'Backend engineer' } } });
  });

  it('leaves legacy events and the agent own text without a message envelope', async () => {
    const { app, db, companyId, worker, person } = await company();
    await db.insert(agentEvents).values({ companyId, agentId: worker.id, kind: 'message', personId: person.id, data: { text: 'Older message.' } });
    await appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'text', data: { text: 'A direct answer to the person.' } });
    const events = await listEvents(db, worker.id, 0);
    expect(events.map(e => e.message)).toEqual([undefined, undefined]);
    expect(events.map(e => e.data)).toEqual([{ text: 'Older message.' }, { text: 'A direct answer to the person.' }]);
  });

  it('keeps a separate outgoing letter for orchestrators, heads and workers without duplicating the send counter', async () => {
    const { app, db, companyId, orchestrator, head, worker } = await company();
    for (const sender of [orchestrator, head, worker]) {
      const target = sender.id === orchestrator.id ? head : orchestrator;
      await appendEvent(app.ctx, { companyId, agentId: target.id, kind: 'message', data: { text: `Letter from ${sender.name}.`, from: 'agent', name: sender.name, by: sender.id } });
      const sent = (await listEvents(db, sender.id, 0)).find(e => e.message?.direction === 'out');
      expect(sent).toMatchObject({ kind: 'message', data: { text: `Letter from ${sender.name}.` }, message: { direction: 'out', from: { kind: 'agent', id: sender.id, agentKind: sender.kind }, to: { id: target.id } } });
      expect(sent!.data).not.toHaveProperty('by');
    }
  });

  it('keeps both copies together and associates the outgoing copy with the sender turn', async () => {
    const { app, db, companyId, head, worker } = await company();
    const run = async (agent: typeof head) => (await db.insert(jobs).values({ companyId, agentId: agent.id, subscriptionId: agent.subscriptionId!, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running' }).returning())[0]!;
    const sender = await run(head);
    const receiver = await run(worker);
    const letter = { companyId, agentId: worker.id, jobId: receiver.id, kind: 'message' as const, data: { text: 'Ship it.', from: 'agent', by: head.id } };
    await expect(appendEvent(app.ctx, letter, async () => { throw new Error('Keep neither copy.'); })).rejects.toThrow('Keep neither copy.');
    expect(await listEvents(db, head.id, 0)).toEqual([]);
    expect(await listEvents(db, worker.id, 0)).toEqual([]);
    await appendEvent(app.ctx, letter);
    expect((await listEvents(db, head.id, 0))[0]).toMatchObject({ jobId: sender.id, message: { direction: 'out' } });
    expect((await listEvents(db, worker.id, 0))[0]).toMatchObject({ jobId: receiver.id, message: { direction: 'in' } });
  });

  it('uses custom department names, optional roles and only identities from the same company', async () => {
    const { app, db, companyId, dev, worker, person } = await company();
    await db.update(departments).set({ name: 'Billing' }).where(eq(departments.id, dev.id));
    await db.update(agents).set({ roleKey: null }).where(eq(agents.id, worker.id));
    await db.update(people).set({ title: '' }).where(eq(people.id, person.id));
    expect(await agentParty(app.ctx, companyId, worker.id)).toMatchObject({ role: null, department: { name: { en: 'Billing' }, templateKey: null } });
    expect(await personParty(app.ctx, companyId, person.id)).toMatchObject({ role: null });
    const otherCompany = '00000000-0000-4000-8000-000000000000';
    await expect(agentParty(app.ctx, otherCompany, worker.id)).rejects.toThrow('does not exist in this company');
    await expect(personParty(app.ctx, otherCompany, person.id)).rejects.toThrow('does not exist in this company');
  });

  it('resolves an orchestrator letter without guessing identity from its text', async () => {
    const { app, companyId, orchestrator, worker } = await company();
    const event = await appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'message', data: { text: 'Ivan (CEO): this is quoted text.', from: 'orchestrator' } });
    expect(event.message).toMatchObject({ from: { kind: 'agent', id: orchestrator.id, agentKind: 'orchestrator' }, to: { id: worker.id } });
  });

  it('leaves old payloads with unrecognized metadata intact', async () => {
    const { db, companyId, worker } = await company();
    const data = { text: 'An old message.', _message: { from: 'Old format' } };
    await db.insert(agentEvents).values({ companyId, agentId: worker.id, kind: 'message', data });
    const [loaded] = await listEvents(db, worker.id, 0);
    expect(loaded!.message).toBeUndefined();
    expect(loaded!.data).toEqual(data);
  });

  it('reads legacy scalar payloads and rejects them for a new message', async () => {
    const { app, db, companyId, worker } = await company();
    for (const data of [null, 'Old text', ['Old text']]) {
      await db.insert(agentEvents).values({ companyId, agentId: worker.id, kind: 'message', data: sql`${JSON.stringify(data)}::jsonb` });
      await expect(appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'message', data })).rejects.toThrow('A message needs an object payload.');
    }
    const events = await listEvents(db, worker.id, 0);
    expect(events.map(e => e.data)).toEqual([null, 'Old text', ['Old text']]);
    expect(events.every(e => !e.message)).toBe(true);
  });

  it('does not use a by field without the trusted agent source marker', async () => {
    const { app, companyId, head, worker } = await company();
    const event = await appendEvent(app.ctx, { companyId, agentId: worker.id, kind: 'message', data: { text: 'A service notice.', by: head.id } });
    expect(event.message!.from.kind).toBe('hornhoof');
  });
});
