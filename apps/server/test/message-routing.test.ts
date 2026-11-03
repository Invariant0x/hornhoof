import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import { appendEvent, listEvents } from '../src/modules/events/store.js';
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
    expect(letter.message).toMatchObject({ from: { kind: 'agent', id: head.id, name: 'Hana', agentKind: 'head', role: { en: 'Head of development', ru: 'Руководитель разработки' }, department: { id: dev.id, name: { en: 'Development', ru: 'Разработка' } } }, to: { id: worker.id } });
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
});
