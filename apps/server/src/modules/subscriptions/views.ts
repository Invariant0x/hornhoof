import type { Limits } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, machines, people, subscriptions, teams, type Provider, type SUBSCRIPTION_STATUSES } from '../../db/schema.js';
import { WHOLE_COMPANY } from '../people/views.js';

export type Place = { kind: 'company' | 'department'; id: string | null; name: string };

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
  machine: { id: string; hostname: string } | null;
  limits: Limits | null;
  isOrchestrator: boolean;
};

export type IsOnline = (sub: { id: string; kind: 'personal' | 'api_key' }) => boolean;

/* Never selects secret_enc or node_key_hash, so they cannot leak into a response. */
const columns = {
  id: subscriptions.id,
  provider: subscriptions.provider,
  kind: subscriptions.kind,
  label: subscriptions.label,
  status: subscriptions.status,
  last4: subscriptions.last4,
  limits: subscriptions.limits,
  targetKind: subscriptions.targetKind,
  targetId: subscriptions.targetId,
  ownerId: people.id,
  ownerName: people.name,
  ownerScopeKind: people.scopeKind,
  ownerScopeId: people.scopeId,
  machineId: machines.id,
  machineHost: machines.hostname,
};

const COMPANY: Place = { kind: 'company', id: null, name: WHOLE_COMPANY };

/* Where a subscription serves. A personal one follows its owner; an API key follows its target. Teams count as their department. */
function placeOf(kind: string | null, id: string | null, depts: Map<string, string>, teamDept: Map<string, string>): Place {
  const deptId = kind === 'department' ? id : kind === 'team' ? teamDept.get(id ?? '') ?? null : null;
  if (!deptId) return COMPANY;
  return { kind: 'department', id: deptId, name: depts.get(deptId) ?? '' };
}

export async function subViews(db: Db, isOnline: IsOnline, id?: string): Promise<SubView[]> {
  const live = isNull(subscriptions.removedAt);
  const rows = await db
    .select(columns)
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.ownerPersonId))
    .leftJoin(machines, eq(machines.id, subscriptions.machineId))
    .where(id ? and(live, eq(subscriptions.id, id)) : live)
    .orderBy(asc(subscriptions.createdAt));
  const depts = new Map((await db.select({ id: departments.id, name: departments.name }).from(departments)).map(d => [d.id, d.name]));
  const teamDept = new Map((await db.select({ id: teams.id, departmentId: teams.departmentId }).from(teams)).map(t => [t.id, t.departmentId]));
  const [orchestrator] = await db.select({ subscriptionId: agents.subscriptionId }).from(agents).where(eq(agents.kind, 'orchestrator'));
  return rows.map(r => ({
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    label: r.label,
    status: r.status,
    online: isOnline({ id: r.id, kind: r.kind }),
    last4: r.last4,
    owner: { id: r.ownerId, name: r.ownerName },
    place: r.kind === 'personal' ? placeOf(r.ownerScopeKind, r.ownerScopeId, depts, teamDept) : placeOf(r.targetKind, r.targetId, depts, teamDept),
    machine: r.machineId ? { id: r.machineId, hostname: r.machineHost ?? '' } : null,
    limits: r.limits ?? null,
    isOrchestrator: orchestrator?.subscriptionId === r.id,
  }));
}

export async function subView(db: Db, isOnline: IsOnline, id: string): Promise<SubView | null> {
  return (await subViews(db, isOnline, id))[0] ?? null;
}
