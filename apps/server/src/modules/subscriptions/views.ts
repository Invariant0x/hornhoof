import type { Account, Limits } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, nodes, people, personAccess, subscriptions, teams, type Provider, type SUBSCRIPTION_STATUSES } from '../../db/schema.js';
import { WHOLE_COMPANY } from '../people/views.js';
import { deptName } from '../departments/templates.js';
import { BUILTIN, nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { planNodes } from '../nodes/nodes.js';

/* listed: a personal plan whose owner has several departments; the name lists them. */
export type Place = { kind: 'company' | 'department' | 'listed'; id: string | null; name: string };

export type SubView = {
  id: string;
  provider: Provider;
  kind: 'personal' | 'api_key';
  label: string;
  status: (typeof SUBSCRIPTION_STATUSES)[number];
  online: boolean;
  last4: string | null;
  owner: { id: string; name: string };
  place: Place;
  /* The machines the plan runs on, oldest first, with its state on each. */
  machines: { id: string; hostname: string; status: 'needs_login' | 'ready'; online: boolean }[];
  limits: Limits | null;
  budget: number | null;
  isOrchestrator: boolean;
  /* The account each machine's program is signed in to: the address only for the plan's owner and people who see the
     whole company. tier when all machines say the same one; accountsDiffer when they are on different ones. */
  accounts: PlanAccount[];
  tier: string | null;
  accountsDiffer: boolean;
  /* The owner signed the plan in once in Hornhoof, so it runs on any of their machines. */
  signedInOnce: boolean;
  /* The machine a Codex plan signed in once runs on now, one at a time. */
  leaseMachine: string | null;
};

export type PlanAccount = { nodeId: string; hostname: string; tier: string | null; email?: string | null };

/* Who asks for the view: the address of a plan's account goes to its owner and to people who see the whole company. */
export type Viewer = { id: string; scopeKind: string };

/* The tier all these accounts are on, and whether they are on different accounts or tiers. */
export function agreed(accounts: Account[]): { tier: string | null; differ: boolean } {
  const tiers = new Set(accounts.map(a => a.tier));
  const differ = new Set(accounts.map(a => `${a.email ?? ''}\n${a.tier ?? ''}`)).size > 1;
  return { tier: tiers.size === 1 ? [...tiers][0]! : null, differ };
}

export type IsOnline = (node: NodeIdentity) => boolean;

/* Never selects secret_enc, so it cannot leak into a response. */
const columns = {
  id: subscriptions.id,
  provider: subscriptions.provider,
  kind: subscriptions.kind,
  label: subscriptions.label,
  status: subscriptions.status,
  last4: subscriptions.last4,
  limits: subscriptions.limits,
  budget: subscriptions.budget,
  credVersion: subscriptions.credVersion,
  leaseNodeId: subscriptions.leaseNodeId,
  targetKind: subscriptions.targetKind,
  targetId: subscriptions.targetId,
  ownerId: people.id,
  ownerName: people.name,
  ownerScopeKind: people.scopeKind,
};

const COMPANY: Place = { kind: 'company', id: null, name: WHOLE_COMPANY };

/* Where an API key serves: its target. Teams count as their department. */
function placeOf(kind: string | null, id: string | null, depts: Map<string, string>, teamDept: Map<string, string>): Place {
  const deptId = kind === 'department' ? id : kind === 'team' ? teamDept.get(id ?? '') ?? null : null;
  if (!deptId) return COMPANY;
  return { kind: 'department', id: deptId, name: depts.get(deptId) ?? '' };
}

/* A personal plan serves wherever its owner works: the whole company, or each listed department, teams counting as theirs. */
function ownerPlace(deptIds: string[], depts: Map<string, string>): Place {
  if (deptIds.length === 1) return { kind: 'department', id: deptIds[0]!, name: depts.get(deptIds[0]!) ?? '' };
  return { kind: 'listed', id: null, name: deptIds.map(d => depts.get(d) ?? '').join(', ') };
}

export async function subViews(db: Db, isOnline: IsOnline, id?: string, viewer: Viewer | null = null): Promise<SubView[]> {
  const live = isNull(subscriptions.removedAt);
  const rows = await db
    .select(columns)
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.ownerPersonId))
    .where(id ? and(live, eq(subscriptions.id, id)) : live)
    .orderBy(asc(subscriptions.createdAt));
  const deptRows = await db
    .select({ id: departments.id, name: departments.name, templateKey: departments.templateKey })
    .from(departments)
    .orderBy(asc(departments.position), asc(departments.createdAt));
  const depts = new Map(deptRows.map(d => [d.id, deptName(d)]));
  const teamDept = new Map((await db.select({ id: teams.id, departmentId: teams.departmentId }).from(teams)).map(t => [t.id, t.departmentId]));
  const listedOwners = [...new Set(rows.filter(r => r.kind === 'personal' && r.ownerScopeKind !== 'company').map(r => r.ownerId))];
  const access = listedOwners.length ? await db.select().from(personAccess).where(inArray(personAccess.personId, listedOwners)) : [];
  /* Each listed owner's departments, in the map's order. */
  const ownerDepts = (ownerId: string) => {
    const mine = new Set(access.filter(a => a.personId === ownerId).map(a => a.departmentId ?? teamDept.get(a.teamId ?? '')));
    return deptRows.filter(d => mine.has(d.id)).map(d => d.id);
  };
  const [orchestrator] = await db.select({ subscriptionId: agents.subscriptionId }).from(agents).where(eq(agents.kind, 'orchestrator'));
  const allNodes = await planNodes(db, rows.filter(r => r.kind === 'personal').map(r => r.id));
  const told = allNodes.length ? await db.select({ id: nodes.id, account: nodes.account }).from(nodes).where(inArray(nodes.id, allNodes.map(n => n.id))) : [];
  const accountOf = new Map(told.map(n => [n.id, n.account]));
  return rows.map(r => {
    const mine = allNodes.filter(n => n.subscriptionId === r.id);
    /* A plan's state is of one machine: one online and signed in, else one online, else what the plan was last. So it
       never shows signed in on one machine and online on another, which can take no turn. */
    const up = mine.filter(n => isOnline(nodeIdentity(n.id)));
    const shown = up.find(n => n.status === 'ready') ?? up[0];
    const sees = viewer !== null && (viewer.id === r.ownerId || viewer.scopeKind === 'company');
    const signed = mine.flatMap(n => {
      const account = accountOf.get(n.id);
      return account ? [{ node: n, account }] : [];
    });
    const { tier, differ } = agreed(signed.map(s => s.account));
    return {
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    label: r.label,
    status: shown?.status ?? r.status,
    online: r.kind === 'api_key' ? isOnline(BUILTIN) : Boolean(shown),
    last4: r.last4,
    owner: { id: r.ownerId, name: r.ownerName },
    place: r.kind === 'api_key' ? placeOf(r.targetKind, r.targetId, depts, teamDept) : r.ownerScopeKind === 'company' ? COMPANY : ownerPlace(ownerDepts(r.ownerId), depts),
    machines: mine.map(n => ({ id: n.machineId, hostname: n.hostname, status: n.status, online: isOnline(nodeIdentity(n.id)) })),
    limits: r.limits ?? null,
    budget: r.budget,
    isOrchestrator: orchestrator?.subscriptionId === r.id,
    accounts: signed.map(({ node, account }) => ({ nodeId: node.id, hostname: node.hostname, tier: account.tier, ...(sees ? { email: account.email } : {}) })),
    tier,
    accountsDiffer: differ,
    signedInOnce: r.kind === 'personal' && r.credVersion > 0,
    leaseMachine: (r.leaseNodeId && mine.find(n => n.id === r.leaseNodeId)?.hostname) || null,
    };
  });
}

export async function subView(db: Db, isOnline: IsOnline, id: string, viewer: Viewer | null = null): Promise<SubView | null> {
  return (await subViews(db, isOnline, id, viewer))[0] ?? null;
}
