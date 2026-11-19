import { candidates } from './decision-people.js';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { canReach } from '../../auth/access.js';
import { decisionOwner, namedOwner, type Candidate, type DecisionSubject } from '../../auth/decision-owner.js';
import { canDecide, decidedBy, type DecidedBy } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, departments, proposals, requests, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { DELETION_CONFLICT } from '../merge/picks.js';
import { isAddressedTo, machinesAway, type MachineAway } from '../nodes/machine-away.js';
import { requestSubject, taskSpot, type Request, type Task } from './state.js';
import { seesTask, type TaskPlace } from './visibility.js';
/* What waits for people, as each person may see it: whose card counts each decision and whose filter shows it, and whether
   this person may take it (auth/decisions.ts). */

export { DEPARTMENTAL, decisionOwner, decisionPlace, listsPlace, type Candidate, type DecisionSubject } from '../../auth/decision-owner.js';

type RequestRow = typeof requests.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;

/* total: what waits for the viewer. What a department's own owner takes is that owner's: its number goes on that owner's card
   and adds nothing to anyone else's, though the CEO and the delegate still see and may take it. */
export type Counts = { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };

/* What waits for people as one person may see it, each with its owner and whether this person may answer it, and the counts
   of all of it. */
export type Decisions = {
  /* known: read with its task and agent; otherwise it shows only because it is this person's to answer. */
  requests: { request: RequestRow; task: TaskRow; ownerPersonId: string; canAnswer: boolean; decidedBy: DecidedBy; known: boolean }[];
  proposals: { proposal: ProposalRow; ownerPersonId: string; canAnswer: boolean; decidedBy: DecidedBy }[];
  /* The merges that left the CEO something to settle, for the CEO alone. after: the time of the backup a restore went
     back to, when the merge is of the database that restore set aside. open: how many of its conflicts are his. */
  merges: { id: string; label: string; after: string | null; open: number; agentId: string; ownerPersonId: string }[];
  machines: MachineAway[];
  counts: Counts;
};

/* Whether a decision is held by a department's named owner other than this viewer. */
function heldElsewhere(subject: DecisionSubject, everyone: readonly Candidate[], viewer: string): boolean {
  const named = namedOwner(subject, everyone);
  return named !== null && named !== viewer;
}

const byTimeAndId = <T extends { createdAt: Date; id: string }>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

function counted(viewer: AgentViewer, owners: { ownerPersonId: string; agentId: string; elsewhere?: boolean }[]): Counts {
  const byPerson: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const d of owners) {
    byPerson[d.ownerPersonId] = (byPerson[d.ownerPersonId] ?? 0) + 1;
    if (seesAgentId(viewer, d.agentId)) byAgent[d.agentId] = (byAgent[d.agentId] ?? 0) + 1;
  }
  return { byPerson, byAgent, total: owners.filter(d => !d.elsewhere).length };
}

/* Whether a person reads a request with the work around it: the task and the agent who asks, both seen. */
const knowsRequest = (viewer: AgentViewer, request: Pick<Request, 'agentId'>, task: TaskPlace): boolean => seesTask(viewer, task) && seesAgentId(viewer, request.agentId);

/* Whether a person opens what shows with a request: when they read it with its work, or while it is open and theirs to
   answer, and then this and nothing around it. */
export async function mayOpenRequest(db: Db, me: Person, request: Request, task: Task): Promise<boolean> {
  const viewer = await viewerOf(db, me);
  return knowsRequest(viewer, request, task) || (request.status === 'open' && canDecide(requestSubject(request, task), me, viewer.access, me.companyId));
}

const shows = (r: { known: boolean; canAnswer: boolean }) => r.known || r.canAnswer;

/* Pending orchestrator proposals go to people who can see them. */
async function orchestratorCards(db: Db, me: Person, viewer: AgentViewer): Promise<ProposalRow[]> {
  const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, me.companyId), eq(agents.kind, 'orchestrator')));
  if (!orchestrator || me.viaHead || me.scopeKind !== 'company' || !seesAgentId(viewer, orchestrator.id)) return [];
  return (await db.select().from(proposals).where(and(eq(proposals.companyId, me.companyId), eq(proposals.status, 'pending')))).sort(byTimeAndId);
}

/* The merges with open conflicts of the CEO's, for the CEO and the orchestrator acting for him; nobody else is told there
   are any. */
async function mergesFor(ctx: Pick<Ctx, 'db'>, me: Person, everyone: readonly Candidate[]): Promise<Decisions['merges']> {
  if (!me.isOwner || me.viaHead) return [];
  const { db } = ctx;
  const found = (await db.execute(sql`SELECT m.id, m.label, m.source, count(*)::int AS open,
      (SELECT r.dumped_at FROM net.restores r WHERE m.source = 'kept:' || r.kept ORDER BY r.at DESC LIMIT 1) AS after
    FROM net.merge_conflicts c JOIN net.merges m ON m.id = c.merge
    WHERE c.picked IS NULL AND ${sql.raw(DELETION_CONFLICT)}
    GROUP BY m.id ORDER BY m.created_at, m.source`)) as unknown as { rows: { id: string; label: string; open: number; after: string | Date | null }[] };
  if (found.rows.length === 0) return [];
  const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, me.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  const owner = decisionOwner({ source: 'merge' }, everyone);
  return found.rows.map(row => ({ id: row.id, label: row.label, after: row.after ? new Date(row.after).toISOString() : null, open: row.open, agentId: orchestrator?.id ?? '', ownerPersonId: owner }));
}

export const openPersonRequests = () => and(eq(requests.status, 'open'), or(ne(requests.kind, 'stuck'), eq(requests.audience, 'human')));

/* Everything waiting for people that this person may see, each with whether they may take it. */
export async function visibleDecisions(ctx: Pick<Ctx, 'db' | 'startedAt'>, me: Person): Promise<Decisions> {
  const { db } = ctx;
  const viewer = await viewerOf(db, me);
  const { access } = viewer;
  const everyone = await candidates(ctx, me.companyId);
  const rows = await db
    .select({ request: requests, task: tasks })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.companyId, me.companyId), openPersonRequests()))
    .orderBy(asc(requests.createdAt), asc(requests.id));
  /* As the routes that take them let them. */
  const judged = (subject: DecisionSubject) => ({ ownerPersonId: decisionOwner(subject, everyone), canAnswer: canDecide(subject, me, access, me.companyId), decidedBy: decidedBy(subject, everyone) });
  const seen = rows
    .filter(r => r.request.recipientPersonId === me.id || canReach(access, taskSpot(r.task)))
    .map(r => ({ ...r, ...judged(requestSubject(r.request, r.task)), known: knowsRequest(viewer, r.request, r.task) }))
    .filter(shows);
  const cards = await orchestratorCards(db, me, viewer);
  const shownCards = cards.map(proposal => ({ proposal, ...judged({ source: 'proposal' }) }));
  const merges = await mergesFor(ctx, me, everyone);
  const counts = counted(viewer, [
    /* One for each merge, however many conflicts it left, asked by the orchestrator. */
    ...merges.filter(merge => merge.agentId).map(merge => ({ ownerPersonId: merge.ownerPersonId, agentId: merge.agentId })),
    ...seen.map(r => ({ ownerPersonId: r.ownerPersonId, agentId: r.request.agentId, elsewhere: heldElsewhere(requestSubject(r.request, r.task), everyone, me.id) })),
    ...shownCards.map(c => ({ ownerPersonId: c.ownerPersonId, agentId: c.proposal.agentId })),
  ]);
  const machines = (await machinesAway(ctx, me.companyId, new Date())).filter(card => isAddressedTo(me, card));
  return { requests: seen, proposals: shownCards, merges, machines, counts };
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
export { candidates, decisionPerson, departmentOwners } from './decision-people.js';
