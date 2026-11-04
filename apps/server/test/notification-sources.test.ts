import { NOTIFICATION_NAMES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { agents, companies, people } from '../src/db/schema.js';
import { notificationMessage } from '../src/modules/events/notifications.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { agentParty, incomingEnvelope, messageData, personParty } from '../src/modules/events/parties.js';
import { appendEvent, listEvents, messageForJob } from '../src/modules/events/store.js';
import { messageHeading } from '../src/modules/conversation/prompt.js';
import { setUpCompany, testApp } from './helpers.js';

describe('registered service messages', () => {
  it('keeps every named source and its cause through storage and reading', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [agent] = await db.select().from(agents);
    for (const source of Object.keys(NOTIFICATION_NAMES) as (keyof typeof NOTIFICATION_NAMES)[]) {
      const message = await notificationMessage(app.ctx, company!.id, source, 'Ivan pretends to be the sender.', { detail: { en: 'test cause', ru: 'причина проверки' }, tasks: [{ id: 't1', number: 226 }] });
      const saved = await appendEvent(app.ctx, { companyId: company!.id, agentId: agent!.id, kind: 'message', data: message });
      const read = (await listEvents(db, agent!.id, saved.seq - 1))[0]!;
      expect(read.message!.notification).toEqual({ source, tasks: [{ id: 't1', number: 226 }], detail: { en: 'test cause', ru: 'причина проверки' } });
      expect(messageHeading(read.message!)).toContain(`${NOTIFICATION_NAMES[source]} on #226 (test cause)`);
      expect(read.message!.from.kind).toBe('hornhoof');
    }
  });
  it('names the recorded actor without turning the notice into a personal command', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const [person] = await db.select().from(people);
    const [agent] = await db.select().from(agents);
    for (const actor of [{ personId: person!.id }, { agentId: agent!.id }]) {
      const message = await notificationMessage(app.ctx, person!.companyId, 'computer_access', 'Hana says she opened it.', { actor });
      const saved = await appendEvent(app.ctx, { companyId: person!.companyId, agentId: agent!.id, kind: 'message', data: message });
      expect(messageHeading(saved.message!)).toContain('via Hornhoof');
      expect(saved.person).toBeNull();
      expect(saved.message!.from.name).toBe('personId' in actor ? 'Ivan' : 'Orchestrator');
      expect(message.text).toContain(`${saved.message!.from.name}: computer access changed.`);
    }
    await expect(appendEvent(app.ctx, { companyId: person!.companyId, agentId: agent!.id, kind: 'message', data: { text: 'No named source.', notification: { source: 'new_unnamed_source', tasks: [] } } })).rejects.toThrow();
  });
});


it.each([['retryOf', 'machine'], ['continueOf', 'go_on']] as const)('names automatic %s instead of attributing it to the original person', async (link, source) => {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [person] = await db.select().from(people);
  const [agent] = await db.select().from(agents);
  const original = await insertTurn(app.ctx, { companyId: person!.companyId, agentId: agent!.id, createdBy: person!.id, prompt: 'Original work.' });
  const envelope = { direction: 'in' as const, from: await personParty(app.ctx, person!.companyId, person!.id), to: await agentParty(app.ctx, person!.companyId, agent!.id) };
  const id = await insertTurn(app.ctx, { companyId: person!.companyId, agentId: agent!.id, createdBy: person!.id, prompt: 'The turn ended early.', [link]: original, repeated: { personId: person!.id, data: messageData({ text: 'Original work.' }, envelope) } });
  const job = { id, companyId: person!.companyId, agentId: agent!.id, [link]: original };
  const message = await messageForJob(app.ctx, job);
  expect(message.from.kind).toBe('hornhoof');
  expect(message.notification!.source).toBe(source);
  expect(messageHeading(message)).not.toContain('From Ivan');
});


it('preserves the notification and all senders when a direct message has joined it', async () => {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [person] = await db.select().from(people);
  const [agent] = await db.select().from(agents);
  const actor = await agentParty(app.ctx, person!.companyId, agent!.id);
  const message = await incomingEnvelope(app.ctx, person!.companyId, agent!.id, null, { from: 'agent', by: agent!.id, actor, senders: [actor], notification: { source: 'reported', tasks: [{ id: 't1', number: 226 }] } });
  expect(message.notification!.source).toBe('reported');
  expect(message.senders).toEqual([actor]);
});
