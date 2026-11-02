import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, WHOLE, type Access, type Spot } from '../../auth/access.js';
import type { Person } from '../../auth/session.js';
import { agents, departments, people, personAccess, proposals, requests, tasks, type DecisionTopic, type REQUEST_KINDS } from '../../db/schema.js';
import type { Asked } from '../computer/access.js';
import { taskSpot } from './engine.js';

/* Who decides what waits for people, and what each person may see of it. The owner only says whose card counts a decision
   and whose filter shows it: who may read or answer it stays as the existing routes check it. */

export type Candidate = { id: string; status: Person['status']; isOwner: boolean; access: Access };

/* A request of an agent on a task, a card of the orchestrator, or its request for the computer the server runs on. */
export type DecisionSubject =
  | { source: 'request'; kind: (typeof REQUEST_KINDS)[number]; topic: DecisionTopic | null; spot: Spot }
  | { source: 'proposal' }
  | { source: 'computer_access' };

/* The topics a department's own person decides; every other one, and one not given, is the CEO's. */
const DEPARTMENTAL: readonly DecisionTopic[] = ['task', 'employee'];

function ceoOf(people: readonly Candidate[]): string {
  const ceo = people.find(p => p.isOwner && p.status === 'active');
  if (!ceo) throw new Error('The company has no active CEO to give its decisions to.');
  return ceo.id;
}

/* Whether a person's access lists the place itself or the department holding it. A team, or the whole company, is not a
   department's own. */
const listsPlace = (access: Access, spot: Spot) =>
  !access.whole && Boolean((spot.departmentId && access.departments.has(spot.departmentId)) || (spot.parentId && access.departments.has(spot.parentId)));

/* A question on a department's task or employee goes to the one active person, other than the CEO, whose access lists that
   department or the product it is about; with nobody or with several such people, to the CEO. People who see the whole
   company decide like the CEO and are no department's own. Approvals, the CEO's topics, unknown topics, the orchestrator's
   own tasks, its cards and its request for the computer go to the CEO. */
export function decisionOwner(d: DecisionSubject, people: readonly Candidate[]): string {
  if (d.source !== 'request' || d.kind === 'approval' || !d.topic || !DEPARTMENTAL.includes(d.topic) || !d.spot.departmentId) return ceoOf(people);
  const own = people.filter(p => p.status === 'active' && !p.isOwner && listsPlace(p.access, d.spot));
  return own.length === 1 ? own[0]!.id : ceoOf(people);
}

type RequestRow = typeof requests.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;

export type Counts = { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };

/* What waits for people as one person may see it, each with its owner and whether this person may answer it, and the counts
   of all of it. */
export type Decisions = {
  requests: { request: RequestRow; task: TaskRow; ownerPersonId: string; canAnswer: boolean }[];
  proposals: { proposal: ProposalRow; ownerPersonId: string; canAnswer: boolean }[];
  computer: { asked: Asked; agentId: string; ownerPersonId: string } | null;
  counts: Counts;
};

/* The company's active and invited people with what each reaches, for owners. */
async function candidates(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Candidate[]> {
  const rows = await ctx.db.select({ id: people.id, status: people.status, isOwner: people.isOwner, scopeKind: people.scopeKind }).from(people).where(eq(people.companyId, companyId));
  const listed = rows.filter(p => p.scopeKind !== 'company').map(p => p.id);
  const access = listed.length ? await ctx.db.select().from(personAccess).where(inArray(personAccess.personId, listed)) : [];
  return rows.map(p => {
    if (p.scopeKind === 'company') return { id: p.id, status: p.status, isOwner: p.isOwner, access: WHOLE };
    const mine = access.filter(a => a.personId === p.id);
    return {
      id: p.id,
      status: p.status,
      isOwner: p.isOwner,
      access: { whole: false, departments: new Set(mine.flatMap(a => (a.departmentId ? [a.departmentId] : []))), teams: new Set(mine.flatMap(a => (a.teamId ? [a.teamId] : []))) },
    };
  });
}

const byTimeAndId = <T extends { createdAt: Date; id: string }>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

function counted(owners: { ownerPersonId: string; agentId: string }[]): Counts {
  const byPerson: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const d of owners) {
    byPerson[d.ownerPersonId] = (byPerson[d.ownerPersonId] ?? 0) + 1;
    byAgent[d.agentId] = (byAgent[d.agentId] ?? 0) + 1;
  }
  return { byPerson, byAgent, total: owners.length };
}

/* Everything waiting for people that this person may see: requests on tasks they reach, the orchestrator's pending cards
   for people who see the whole company, and the orchestrator's request for the computer for the real CEO only. */
export async function visibleDecisions(ctx: Pick<Ctx, 'db' | 'computer'>, me: Person): Promise<Decisions> {
  const { db } = ctx;
  const access = await accessOf(db, me);
  const everyone = await candidates(ctx, me.companyId);
  const rows = await db
    .select({ request: requests, task: tasks })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.companyId, me.companyId), eq(requests.status, 'open')))
    .orderBy(asc(requests.createdAt), asc(requests.id));
  const whole = me.scopeKind === 'company';
  const seen = rows
    .filter(r => canReach(access, taskSpot(r.task)))
    .map(r => ({
      ...r,
      ownerPersonId: decisionOwner({ source: 'request', kind: r.request.kind, topic: r.request.decisionTopic, spot: taskSpot(r.task) }, everyone),
      /* As POST /api/requests/:id lets them: anyone who reaches the task, and for an approval someone who sees the whole company. */
      canAnswer: r.request.kind !== 'approval' || whole,
    }));
  const cards = whole ? (await db.select().from(proposals).where(and(eq(proposals.companyId, me.companyId), eq(proposals.status, 'pending')))).sort(byTimeAndId) : [];
  const shownCards = cards.map(proposal => ({ proposal, ownerPersonId: decisionOwner({ source: 'proposal' }, everyone), canAnswer: true }));
  /* The control folder is read once, for the item and for the counts alike. */
  const asked = me.isOwner && !me.via ? ctx.computer.view().asked : null;
  const [orchestrator] = asked ? await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, me.companyId), eq(agents.kind, 'orchestrator'))) : [];
  const computer = asked && orchestrator ? { asked, agentId: orchestrator.id, ownerPersonId: decisionOwner({ source: 'computer_access' }, everyone) } : null;
  const counts = counted([
    ...seen.map(r => ({ ownerPersonId: r.ownerPersonId, agentId: r.request.agentId })),
    ...shownCards.map(c => ({ ownerPersonId: c.ownerPersonId, agentId: c.proposal.agentId })),
    ...(computer ? [{ ownerPersonId: computer.ownerPersonId, agentId: computer.agentId }] : []),
  ]);
  return { requests: seen, proposals: shownCards, computer, counts };
}

/* The number on a person's card: their decisions this viewer sees, none for the viewer's own card or for anyone's when the
   viewer sees the whole company, and nothing at all for another person's when the viewer sees only part of it. */
export function pendingFor(d: Decisions, me: Person, personId: string): number | null {
  const n = d.counts.byPerson[personId];
  if (n !== undefined) return n;
  return personId === me.id || me.scopeKind === 'company' ? 0 : null;
}

/* The names of the departments cards are for. */
export async function departmentNames(ctx: Pick<Ctx, 'db'>, ids: string[]): Promise<Map<string, typeof departments.$inferSelect>> {
  if (!ids.length) return new Map();
  return new Map((await ctx.db.select().from(departments).where(inArray(departments.id, ids))).map(d => [d.id, d]));
}
