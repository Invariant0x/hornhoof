import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, WHOLE, type Access, type Spot } from '../../auth/access.js';
import { decisionOwner, type Candidate, type DecisionSubject } from '../../auth/decision-owner.js';
import type { Person } from '../../auth/session.js';
import { agents, departments, people, personAccess, proposals, requests, tasks } from '../../db/schema.js';
import { ownsComputer, type Asked } from '../computer/access.js';
import { taskSpot } from './engine.js';

/* What waits for people, as each person may see it: whose card counts each decision and whose filter shows it, and whether
   this person may take it (auth/decisions.ts). */

export { DEPARTMENTAL, decisionOwner, decisionPlace, listsPlace, type Candidate, type DecisionSubject } from '../../auth/decision-owner.js';

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

/* The addressee of a question uses the same ownership policy as its decision card. */
export async function decisionPerson(ctx: Pick<Ctx, 'db'>, companyId: string, subject: DecisionSubject): Promise<string> {
  return decisionOwner(subject, await candidates(ctx, companyId));
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
  const asked = ownsComputer(me) ? ctx.computer.view().asked : null;
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
