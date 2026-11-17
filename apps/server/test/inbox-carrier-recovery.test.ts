import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentEvents, agentInbox, agents, companies, jobs, people, subscriptions } from '../src/db/schema.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { testApp } from './helpers.js';

/* The recorded end of an ordinary turn carrying an inbox summary: no provider, node or external program runs. */
/* none: the program said nothing in the turn. enter: a person pressed Enter in the terminal meanwhile, which marks a
   speaker and proves nothing of the prompt. answered: the program's own words for the turn show it got its prompt. */
it.each([['none', 'unread'], ['enter', 'unread'], ['answered', 'read']] as const)('restores folded inbox mail of a failed carrier whose program never answered it, %s', async (seen, expected) => {
  const { app, db } = await testApp();
  const [company] = await db.insert(companies).values({ name: 'Carrier fixture' }).returning();
  const companyId = company!.id;
  const [owner] = await db.insert(people).values({ companyId, name: 'Owner', email: 'owner@carrier.example.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId, ownerPersonId: owner!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Fixture', status: 'needs_login' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, name: 'Bruno', kind: 'worker', model: '', subscriptionId: sub!.id }).returning();
  const [carrier] = await db.insert(jobs).values({ companyId, agentId: agent!.id, subscriptionId: sub!.id, kind: 'conversation', status: 'failed', error: 'agent_failed', prompt: 'Ordinary words and the inbox summary.', inboxWake: false, timeoutMs: 900000, startedAt: new Date(), finishedAt: new Date() }).returning();
  const [letter] = await db.insert(agentInbox).values({ companyId, agentId: agent!.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'Preserve this folded letter.', status: 'read', readAt: new Date(), jobId: carrier!.id }).returning();
  if (seen === 'enter') await db.insert(agentEvents).values({ companyId, agentId: agent!.id, jobId: carrier!.id, kind: 'typed', data: {}, personId: owner!.id });
  if (seen === 'answered') await db.insert(agentEvents).values({ companyId, agentId: agent!.id, jobId: carrier!.id, kind: 'text', data: { kind: 'text', text: 'Recorded answer.' } });

  await afterJob(app.ctx, carrier!.id);

  const [after] = await db.select().from(agentInbox).where(eq(agentInbox.id, letter!.id));
  expect(after!.status).toBe(expected);
});
