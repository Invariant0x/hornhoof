import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { personColumns, type Person } from '../../auth/session.js';
import { agents, assistantRequests, assistants, departments, people, requests } from '../../db/schema.js';
import { departmentParty } from '../events/parties.js';
import { visibleDecisions } from '../tasks/decisions.js';
import { uncheckedLines } from '../tasks/unchecked.js';
import { storeEvent } from './events.js';
import type { Told } from './replies.js';

type Seen = Awaited<ReturnType<typeof visibleDecisions>>['requests'][number];

/* A request that waits for the person, as their assistant reads it: what is asked and the ways to answer, the task and the
   agent it is from, and whether the assistant may answer it for them. */
export type RequestView = ReturnType<typeof viewOf>;

function viewOf(r: Seen, names: Map<string, string>, depts: Map<string, typeof departments.$inferSelect>) {
  const { request, task } = r;
  const dept = task.departmentId ? depts.get(task.departmentId) : undefined;
  return {
    id: request.id,
    kind: request.kind,
    topic: request.decisionTopic,
    text: request.text,
    explained: request.explained,
    options: request.options.map(o => o.label),
    commit: request.commit,
    /* What the release of that commit brings that no check covers, as Hornhoof wrote it on the card. */
    unchecked: request.unchecked ? uncheckedLines(request.unchecked) : null,
    approval: request.approvalChannel ? { channel: request.approvalChannel, kind: request.approvalKind, amount: request.approvalAmount } : null,
    link: request.link,
    task: { id: task.id, number: task.number, title: task.title },
    agent: r.known ? { id: request.agentId, name: names.get(request.agentId) ?? '' } : null,
    department: dept ? departmentParty(dept) : null,
    askedAt: request.createdAt.toISOString(),
    answerable: r.canAnswer,
  };
}

/* The open requests that wait for this person, as Hornhoof gives them to people: the ones they own, in the order asked. */
export async function waitingFor(ctx: Ctx, me: Person): Promise<RequestView[]> {
  const mine = (await visibleDecisions(ctx, me)).requests.filter(r => r.ownerPersonId === me.id);
  const agentIds = [...new Set(mine.map(r => r.request.agentId))];
  const names = new Map(agentIds.length ? (await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map(a => [a.id, a.name]) : []);
  const depts = new Map((await ctx.db.select().from(departments).where(eq(departments.companyId, me.companyId))).map(d => [d.id, d]));
  return mine.map(r => viewOf(r, names, depts));
}

/* The assistants of the company that have a key, each with its owner as they are now. */
async function keyed(ctx: Ctx, companyId: string): Promise<{ id: string; owner: Person }[]> {
  const helpers = await ctx.db
    .select({ id: people.id, ownerId: people.assistantOf })
    .from(people)
    .innerJoin(assistants, eq(assistants.personId, people.id))
    .where(and(eq(people.companyId, companyId), eq(people.isAgent, true), eq(people.status, 'active'), isNotNull(assistants.keyHash)));
  const ownerIds = helpers.map(h => h.ownerId!);
  const owners = ownerIds.length ? await ctx.db.select(personColumns).from(people).where(and(inArray(people.id, ownerIds), eq(people.status, 'active'))) : [];
  return helpers.flatMap(h => {
    const owner = owners.find(o => o.id === h.ownerId);
    return owner ? [{ id: h.id, owner }] : [];
  });
}

/* Tells one assistant of each request that came to wait for its owner, and of each that waits no more, once. */
async function tellOne(ctx: Ctx, companyId: string, assistantId: string, owner: Person, told: Told): Promise<void> {
  const open = await waitingFor(ctx, owner);
  const known = (await ctx.db.select({ id: assistantRequests.requestId }).from(assistantRequests).where(eq(assistantRequests.assistantId, assistantId))).map(r => r.id);
  for (const view of open.filter(r => !known.includes(r.id))) {
    const seq = await storeEvent(ctx.db, { companyId, assistantId, kind: 'request', data: { request: view } }, async tx => {
      await tx.insert(assistantRequests).values({ assistantId, requestId: view.id });
    });
    told(assistantId, seq, 'request');
  }
  const gone = known.filter(id => !open.some(r => r.id === id));
  if (!gone.length) return;
  const states = await ctx.db.select({ id: requests.id, status: requests.status }).from(requests).where(inArray(requests.id, gone));
  for (const { id, status } of states) {
    const seq = await storeEvent(ctx.db, { companyId, assistantId, kind: 'request_closed', data: { requestId: id, status } }, async tx => {
      await tx.delete(assistantRequests).where(and(eq(assistantRequests.assistantId, assistantId), eq(assistantRequests.requestId, id)));
    });
    told(assistantId, seq, 'request_closed');
  }
}

/* What waits for the owners of the company's assistants, against what each was told already. */
export async function tellRequests(ctx: Ctx, companyId: string, told: Told): Promise<void> {
  for (const { id, owner } of await keyed(ctx, companyId)) await tellOne(ctx, companyId, id, owner, told);
}
