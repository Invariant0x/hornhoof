import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentEvents, agentInbox, agents, companies, jobs, people, subscriptions } from '../src/db/schema.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { testApp } from './helpers.js';

/* The recorded end of an ordinary turn carrying an inbox summary: no provider, node or external program runs. */
it.each([false, true])('restores folded inbox mail only before the carrier typed its prompt, typed=%s', async typed => {
  const { app, db } = await testApp();
  const [company] = await db.insert(companies).values({ name: 'Carrier fixture' }).returning();
  const companyId = company!.id;
  const [owner] = await db.insert(people).values({ companyId, name: 'Owner', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId, ownerPersonId: owner!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Fixture', status: 'needs_login' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, name: 'Bruno', kind: 'worker', model: '', subscriptionId: sub!.id }).returning();
  const [carrier] = await db.insert(jobs).values({ companyId, agentId: agent!.id, subscriptionId: sub!.id, kind: 'conversation', status: 'failed', error: 'agent_failed', prompt: 'Ordinary words and the inbox summary.', inboxWake: false, timeoutMs: 900000, startedAt: new Date(), finishedAt: new Date() }).returning();
  const [letter] = await db.insert(agentInbox).values({ companyId, agentId: agent!.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'Preserve this folded letter.', status: 'read', readAt: new Date(), jobId: carrier!.id }).returning();
  if (typed) await db.insert(agentEvents).values({ companyId, agentId: agent!.id, jobId: carrier!.id, kind: 'typed', data: {} });

  await afterJob(app.ctx, carrier!.id);

  const [after] = await db.select().from(agentInbox).where(eq(agentInbox.id, letter!.id));
  expect(after!.status).toBe(typed ? 'read' : 'unread');
});
