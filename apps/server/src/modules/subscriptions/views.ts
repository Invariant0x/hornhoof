import { apiEndpoint, currentLimits, modelsFor, type Account, type ApiEndpoint, type Limits, type ModelOption } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, machines, nodes, people, personAccess, subscriptions, teams, type NodeStatus, type PlanFallback, type Provider, type SUBSCRIPTION_STATUSES, type TARGET_KINDS } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { WHOLE_COMPANY } from '../people/views.js';
import { deptName } from '../departments/templates.js';
import { nodeIdentity, ownBuiltin, type NodeIdentity, type NodeHub } from '../nodes/hub.js';
import { planHostContacts } from '../nodes/machine-contact.js';
import { isBuiltinHost, planNodes, type NodeRow } from '../nodes/nodes.js';

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
  machines: { id: string; hostname: string; status: NodeStatus; online: boolean; hostOnline?: boolean; hostLastSeenAt?: string | null }[];
  limits: Limits | null;
  limitsUpdatedAt: string | null;
  budget: number | null;
  turnLimit: number;
  /* The plans its employees go on to at its limit, in order; empty for any plan of the company that may serve them. */
  fallbacks: PlanFallback[];
  isOrchestrator: boolean;
  /* The account each machine's program is signed in to: the address only for the plan's owner and the CEO.
     tier when all machines say the same one; accountsDiffer when they are on different ones. */
  accounts: PlanAccount[];
  tier: string | null;
  accountsDiffer: boolean;
  /* The owner signed the plan in once in Hornhoof, so it runs on any of their machines. */
  signedInOnce: boolean;
  /* The machine a Codex plan signed in once runs on now, one at a time. */
  leaseMachine: string | null;
  /* Where an API connection's program sends its calls and in which protocol; none for a plan. */
  api: ApiEndpoint | null;
  /* The models it runs: an API connection's own, or the ones its node reported. */
  models: ModelOption[];
  /* The place an API connection was given, which its place shows by department: the orchestrator, any department, or one
     department or team. None for a plan, which serves wherever its owner works. */
  target: { kind: (typeof TARGET_KINDS)[number]; id: string | null } | null;
};

export type PlanAccount = { nodeId: string; hostname: string; tier: string | null; email?: string | null };

/* Who asks for the view: the address of a plan's account goes to its owner and to the CEO. */
export type Viewer = { id: string; companyId: string; scopeKind: string; isOwner?: boolean; via?: string; viaHead?: true };

/* The tier all these accounts are on, and whether they are on different accounts or tiers. */
export function agreed(accounts: Account[]): { tier: string | null; differ: boolean } {
  const tiers = new Set(accounts.map(a => a.tier));
  const differ = new Set(accounts.map(a => `${a.email ?? ''}\n${a.tier ?? ''}`)).size > 1;
  return { tier: tiers.size === 1 ? [...tiers][0]! : null, differ };
}

/* Whether a node is connected; asked of 'builtin', whether any machine's built-in node is, which is where an API key's
   work runs. */
type LocalHost = { key: string; networkId: string | null };
type IsOnline = ((node: NodeIdentity | 'builtin') => boolean) & { localHostConnected?: (host: LocalHost) => boolean };

export const onlineIn = (hub: Pick<NodeHub, 'isOnline' | 'builtins'>, config: { machineId: string | null; hostId?: string | null }): IsOnline => {
  const own = ownBuiltin(config);
  return Object.assign(
    (node: NodeIdentity | 'builtin') => node === 'builtin' ? hub.isOnline(own) || hub.builtins().length > 0 : hub.isOnline(node),
    { localHostConnected: (host: LocalHost) => hub.isOnline(own) && isBuiltinHost(host, config.hostId ?? null, config.machineId) },
  );
};

/* Never selects secret_enc, so it cannot leak into a response. */
const columns = {
  id: subscriptions.id,
  provider: subscriptions.provider,
  kind: subscriptions.kind,
  label: subscriptions.label,
  status: subscriptions.status,
  last4: subscriptions.last4,
  limits: subscriptions.limits,
  limitsUpdatedAt: subscriptions.limitsUpdatedAt,
  budget: subscriptions.budget,
  turnLimit: subscriptions.turnLimit,
  fallbacks: subscriptions.fallbacks,
  credVersion: subscriptions.credVersion,
  leaseNodeId: subscriptions.leaseNodeId,
  targetKind: subscriptions.targetKind,
  targetId: subscriptions.targetId,
  baseUrl: subscriptions.baseUrl,
  apiProtocol: subscriptions.apiProtocol,
  models: subscriptions.models,
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

type PlaceSource = Pick<typeof subscriptions.$inferSelect, 'kind' | 'targetKind' | 'targetId'> & { ownerScopeKind: string };

function subscriptionPlace(row: PlaceSource, ownerDepts: string[], depts: Map<string, string>, teamDept: Map<string, string>): Place {
  if (row.kind === 'api_key') return placeOf(row.targetKind, row.targetId, depts, teamDept);
  return row.ownerScopeKind === 'company' ? COMPANY : ownerPlace(ownerDepts, depts);
}

/* Each listed owner's departments, in the map's order. */
function ownerDepartments(ownerId: string, access: (typeof personAccess.$inferSelect)[], ordered: string[], teamDept: Map<string, string>): string[] {
  const mine = new Set(access.filter(a => a.personId === ownerId).map(a => a.departmentId ?? teamDept.get(a.teamId ?? '')));
  return ordered.filter(id => mine.has(id));
}

function accountViews(mine: NodeRow[], accountOf: Map<string, Account | null>, viewer: Viewer | null, ownerId: string): Pick<SubView, 'accounts' | 'tier' | 'accountsDiffer'> {
  /* The address goes to the plan's owner and the CEO, and to the orchestrator acting for the CEO: never to a head. */
  const sees = viewer !== null && !viewer.viaHead && (viewer.id === ownerId || viewer.isOwner === true);
  const signed = mine.flatMap(node => {
    const account = accountOf.get(node.id);
    return account ? [{ node, account }] : [];
  });
  const { tier, differ } = agreed(signed.map(s => s.account));
  return {
    accounts: signed.map(({ node, account }) => ({ nodeId: node.id, hostname: node.hostname, tier: account.tier, ...(sees ? { email: account.email } : {}) })),
    tier,
    accountsDiffer: differ,
  };
}

/* Of a plan's machines online, the one whose state the plan shows: one signed in and set up, else one signed in that waits
   for its program's first setup, else the first. */
const shownNode = <T extends { status: string }>(up: T[]): T | undefined => up.find(n => n.status === 'ready') ?? up.find(n => n.status === 'needs_setup') ?? up[0];

function connectionView(n: NodeRow, online: boolean, contact?: { online: boolean; lastSeenAt: Date | null }) {
  return { id: n.machineId, hostname: n.hostname, status: n.status, online,
    ...(contact && { hostOnline: contact.online, hostLastSeenAt: contact.lastSeenAt?.toISOString() ?? null }) };
}

async function planConnections(db: Db, allNodes: NodeRow[], isOnline: IsOnline, viewer: Viewer | null) {
  const told = allNodes.length ? await db.select({ id: nodes.id, account: nodes.account, machineId: machines.id, key: machines.machineKey,
    networkId: machines.networkId, reportAt: machines.reportAt, machineOwnerId: machines.personId })
    .from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(inArray(nodes.id, allNodes.map(n => n.id))) : [];
  const visibleHosts = told.filter(n => viewer?.scopeKind === 'company' || viewer?.id === n.machineOwnerId);
  const contacts = await planHostContacts(db, visibleHosts, isOnline, isOnline.localHostConnected);
  const connections = new Map(allNodes.map(n => [n.id, connectionView(n, isOnline(nodeIdentity(n.id)), contacts.get(n.machineId))]));
  return { connections, accountOf: new Map(told.map(n => [n.id, n.account])) };
}

export async function subViews(db: Db, isOnline: IsOnline, id?: string, viewer: Viewer | null = null): Promise<SubView[]> {
  const live = isNull(subscriptions.removedAt);
  const companyId = viewer?.companyId;
  const rows = await db
    .select(columns)
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.ownerPersonId))
    .where(and(live, id ? eq(subscriptions.id, id) : undefined, companyId ? eq(subscriptions.companyId, companyId) : undefined))
    .orderBy(asc(subscriptions.createdAt));
  const deptRows = await db
    .select({ id: departments.id, name: departments.name, templateKey: departments.templateKey })
    .from(departments)
    .where(companyId ? eq(departments.companyId, companyId) : undefined)
    .orderBy(asc(departments.position), asc(departments.createdAt));
  const depts = new Map(deptRows.map(d => [d.id, deptName(d)]));
  const teamDept = new Map((await db.select({ id: teams.id, departmentId: teams.departmentId }).from(teams).where(companyId ? eq(teams.companyId, companyId) : undefined)).map(t => [t.id, t.departmentId]));
  const listedOwners = [...new Set(rows.filter(r => r.kind === 'personal' && r.ownerScopeKind !== 'company').map(r => r.ownerId))];
  const access = listedOwners.length ? await db.select().from(personAccess).where(inArray(personAccess.personId, listedOwners)) : [];
  const orderedDepts = deptRows.map(d => d.id);
  const [orchestrator] = await db.select(only(agents, 'subscriptionId')).from(agents).where(and(eq(agents.kind, 'orchestrator'), companyId ? eq(agents.companyId, companyId) : undefined));
  const allNodes = await planNodes(db, rows.filter(r => r.kind === 'personal').map(r => r.id));
  const { accountOf, connections } = await planConnections(db, allNodes, isOnline, viewer);
  return rows.map(r => {
    const mine = allNodes.filter(n => n.subscriptionId === r.id);
    /* A plan's state is of one machine online, else what the plan was last. So it never shows signed in on one machine and
       online on another, which can take no turn. */
    const up = mine.filter(n => connections.get(n.id)!.online);
    const shown = shownNode(up);
    return {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      label: r.label,
      status: shown?.status ?? r.status,
      online: r.kind === 'api_key' ? isOnline('builtin') : Boolean(shown),
      last4: r.last4,
      owner: { id: r.ownerId, name: r.ownerName },
      place: subscriptionPlace(r, ownerDepartments(r.ownerId, access, orderedDepts, teamDept), depts, teamDept),
      machines: mine.map(n => connections.get(n.id)!),
      limits: currentLimits(r.limits ?? null, r.limitsUpdatedAt),
      limitsUpdatedAt: r.limitsUpdatedAt?.toISOString() ?? null,
      budget: r.budget,
      turnLimit: r.turnLimit,
      fallbacks: r.fallbacks,
      isOrchestrator: orchestrator?.subscriptionId === r.id,
      ...accountViews(mine, accountOf, viewer, r.ownerId),
      signedInOnce: r.kind === 'personal' && r.credVersion > 0,
      leaseMachine: (r.leaseNodeId && mine.find(n => n.id === r.leaseNodeId)?.hostname) || null,
      api: r.kind === 'api_key' ? apiEndpoint(r.provider, { baseUrl: r.baseUrl, protocol: r.apiProtocol }) : null,
      models: modelsFor(r.provider, r.models),
      target: r.kind === 'api_key' && r.targetKind ? { kind: r.targetKind, id: r.targetId } : null,
    };
  });
}

/* Nothing of a plan's key, not even its end, reaches someone who sees neither the whole company nor their own plan in it:
   the owner of a department sees its employees on others' plans. */
export const keyEndFor = (viewer: Pick<Viewer, 'id' | 'scopeKind'>, view: SubView): SubView =>
  viewer.scopeKind === 'company' || view.owner.id === viewer.id ? view : { ...view, last4: null };

export async function subView(db: Db, isOnline: IsOnline, id: string, viewer: Viewer | null = null): Promise<SubView | null> {
  return (await subViews(db, isOnline, id, viewer))[0] ?? null;
}
