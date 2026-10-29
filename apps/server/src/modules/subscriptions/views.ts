import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { departments, people, subscriptions, teams, TARGET_KINDS, type Provider } from '../../db/schema.js';

export type SubView = {
  id: string;
  provider: Provider;
  kind: 'personal' | 'api_key';
  label: string;
  status: 'active' | 'waiting_machine';
  last4: string | null;
  owner: { id: string; name: string };
  target: { kind: (typeof TARGET_KINDS)[number]; id: string | null; name: string };
};

/* Never selects secret_enc or join_code_hash, so they cannot leak into a response. */
const columns = {
  id: subscriptions.id,
  provider: subscriptions.provider,
  kind: subscriptions.kind,
  label: subscriptions.label,
  status: subscriptions.status,
  last4: subscriptions.last4,
  ownerId: people.id,
  ownerName: people.name,
  targetKind: subscriptions.targetKind,
  targetId: subscriptions.targetId,
};

const FIXED_TARGETS = { chief: 'Chief', any: 'Any department' } as const;

export async function subViews(db: Db, id?: string): Promise<SubView[]> {
  const query = db.select(columns).from(subscriptions).innerJoin(people, eq(people.id, subscriptions.ownerPersonId));
  const rows = await (id ? query.where(eq(subscriptions.id, id)) : query).orderBy(asc(subscriptions.createdAt));
  const names = new Map<string, string>();
  for (const d of await db.select({ id: departments.id, name: departments.name }).from(departments)) names.set(d.id, d.name);
  for (const t of await db.select({ id: teams.id, name: teams.name }).from(teams)) names.set(t.id, t.name);
  return rows.map(r => ({
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    label: r.label,
    status: r.status,
    last4: r.last4,
    owner: { id: r.ownerId, name: r.ownerName },
    target: {
      kind: r.targetKind,
      id: r.targetId,
      name: r.targetKind === 'chief' || r.targetKind === 'any' ? FIXED_TARGETS[r.targetKind] : names.get(r.targetId ?? '') ?? '',
    },
  }));
}

export async function subView(db: Db, id: string): Promise<SubView | null> {
  return (await subViews(db, id))[0] ?? null;
}
