import { and, asc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, tasks, turns } from '../../db/schema.js';
import { note } from './events.js';
import { keepWakes } from './outbox.js';
import { CLOSED, type Task, type Tx, type Wake } from './state.js';

/* A development department runs its turn in slots, one per developer and five at most: a slot holds one task, and one small
   addition of the same product may join it. A new top-level task that finds every slot busy waits in the department's queue
   for the next turn, which takes the queue in as it opens; the one after next waits behind it, in batches of the slots.
   Urgent work takes no slot and waits for none. A department with no slot cap gives every task out at once. */

export const DEFAULT_SLOT_CAP = 5;
/* The employees who count as developers: the members that build, outside any sub-unit. */
const DEVELOPER_ROLES = ['DEV-ENG', 'DEV-BE', 'DEV-FE'];

/* The cap a new department of this template starts with. */
export const slotCapOfNew = (templateKey: string | null | undefined): number | null => (templateKey === 'development' ? DEFAULT_SLOT_CAP : null);

type Db_ = Db | Tx;
type Piece = Pick<Task, 'productId' | 'small'>;
export type Queued = { ahead: number; position: number; openTurn: number | null };

/* What runs: the department's top-level tasks that are open, not queued and not urgent. */
const running = (db: Db_, departmentId: string) =>
  db
    .select({ productId: tasks.productId, small: tasks.small })
    .from(tasks)
    .where(and(eq(tasks.departmentId, departmentId), isNull(tasks.parentId), isNull(tasks.queuedAt), eq(tasks.urgent, false), notInArray(tasks.status, [...CLOSED])));

/* The slots in use: of each product, as many as the larger of its tasks and its small additions, since an addition rides on a task. */
export function slotsUsed(pieces: Piece[]): number {
  const byProduct = new Map<string | null, { big: number; small: number }>();
  for (const p of pieces) {
    const c = byProduct.get(p.productId) ?? { big: 0, small: 0 };
    byProduct.set(p.productId, p.small ? { ...c, small: c.small + 1 } : { ...c, big: c.big + 1 });
  }
  return [...byProduct.values()].reduce((sum, c) => sum + Math.max(c.big, c.small), 0);
}

/* How many slots the department holds now: its cap, at most the developers it has, and one at least. None: no slots. */
export async function slotCapacity(db: Db_, departmentId: string): Promise<number | null> {
  const [department] = await db.select({ cap: departments.slotCap }).from(departments).where(eq(departments.id, departmentId));
  if (department?.cap == null) return null;
  const members = await db
    .select({ id: agents.id, role: agents.roleKey })
    .from(agents)
    .where(and(eq(agents.departmentId, departmentId), eq(agents.kind, 'worker'), isNull(agents.teamId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  const developers = members.filter(m => m.role && DEVELOPER_ROLES.includes(m.role)).length;
  return Math.max(1, Math.min(department.cap, developers));
}

/* Whether the department this task is in runs slots: where it does, work given to a busy developer waits for them. */
export async function slotsApply(db: Db_, task: Pick<Task, 'departmentId'>): Promise<boolean> {
  return task.departmentId ? (await slotCapacity(db, task.departmentId)) !== null : false;
}

const queuedOf = (db: Db_, departmentId: string) =>
  db.select().from(tasks).where(and(eq(tasks.departmentId, departmentId), isNotNull(tasks.queuedAt))).orderBy(asc(tasks.queuedAt), asc(tasks.number));

/* Whether the work given joins a slot now or waits for the next turn. A small addition joins a slot of its product that has
   none yet; anything else takes a free slot, unless others already wait, who go first. */
export async function slotVerdict(db: Db_, departmentId: string, piece: Piece & { urgent?: boolean | null }): Promise<'run' | 'queue'> {
  const cap = await slotCapacity(db, departmentId);
  if (cap === null || piece.urgent) return 'run';
  const now = await running(db, departmentId);
  const used = slotsUsed(now);
  if (piece.small && slotsUsed([...now, piece]) === used) return 'run';
  if ((await queuedOf(db, departmentId)).length) return 'queue';
  return slotsUsed([...now, piece]) <= cap ? 'run' : 'queue';
}

/* What a person reads of a queued task: how many turns ahead it waits (the next is 1, in batches of the slots), its place in
   the queue and the department's open turn it waits behind. */
export async function queueFacts(db: Db_, rows: Pick<Task, 'id' | 'departmentId' | 'queuedAt'>[]): Promise<Map<string, Queued>> {
  const facts = new Map<string, Queued>();
  for (const departmentId of new Set(rows.filter(t => t.queuedAt && t.departmentId).map(t => t.departmentId!))) {
    const cap = (await slotCapacity(db, departmentId)) ?? 1;
    const [open] = await db.select({ number: turns.number }).from(turns).where(and(eq(turns.departmentId, departmentId), eq(turns.status, 'open')));
    (await queuedOf(db, departmentId)).forEach((t, i) => facts.set(t.id, { position: i + 1, ahead: Math.floor(i / cap) + 1, openTurn: open?.number ?? null }));
  }
  return facts;
}

/* The words for the turn a queued task waits for. */
export const waitsText = (ahead: number): string => (ahead === 1 ? 'waits for the next turn' : ahead === 2 ? 'waits for the turn after next' : `waits ${ahead} turns ahead`);

async function holderOf(tx: Tx, task: Task): Promise<string | null> {
  const [own] = task.executorAgentId ? await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, task.executorAgentId), isNull(agents.removedAt))) : [];
  if (own) return own.id;
  const [head] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.departmentId, task.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt)))
    .orderBy(asc(agents.createdAt));
  return head?.id ?? null;
}

/* The turn that opens takes the queue in: in order, as many as the slots hold, each to its named holder or the head, who is
   woken for it. What does not fit, and what has no one to take it, waits for the turn after. */
export async function loadQueue(tx: Tx, companyId: string, departmentId: string): Promise<{ task: Task; wake: Wake }[]> {
  const cap = await slotCapacity(tx, departmentId);
  if (cap === null) return [];
  const now = await running(tx, departmentId);
  const loaded: { task: Task; wake: Wake }[] = [];
  for (const queued of await queuedOf(tx, departmentId)) {
    if (slotsUsed([...now, queued]) > cap) break;
    const holder = await holderOf(tx, queued);
    if (!holder) break;
    const [row] = await tx.update(tasks).set({ assigneeAgentId: holder, queuedAt: null, updatedAt: new Date() }).where(eq(tasks.id, queued.id)).returning();
    await note(tx, row!, { kind: 'assigned', actor: { agentId: queued.createdByAgentId ?? holder }, text: 'The next turn took it in from the queue.', data: { assignee: holder } });
    now.push(queued);
    loaded.push({ task: row!, wake: { agentId: holder, taskId: row!.id, why: 'assigned' } });
  }
  await keepWakes(tx, companyId, loaded.map(l => l.wake));
  return loaded;
}
