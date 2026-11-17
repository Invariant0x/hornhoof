import { TEMPLATE_KEYS } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { agents, departments, personAccess, subscriptions, tasks, teams } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { deptName, TEMPLATE_TEXT } from '../departments/templates.js';

const Name = z.string().trim().min(1).max(60);
const Note = z.string().max(160);
const Products = z.array(Name).max(10);
export const TeamChange = z.union([Name, z.object({ id: z.uuid(), name: Name.optional(), remove: z.boolean().optional() })]);
export type TeamChange = z.infer<typeof TeamChange>;

/* A department to create from a template. name only when the template is used a second time, such as "Sales Europe". */
/* staff: the department comes with the people of its template, each on the plan and model its role asks for, or waiting
   for a plan when none serves it yet. */
export const NewItem = z.object({ template: z.enum(TEMPLATE_KEYS), name: Name.optional(), checked: z.boolean(), note: Note, products: Products.optional(), teams: Products.optional(), staff: z.boolean().optional() });
/* A change to a department that exists: products to add under it, sub-units to create, rename or remove, or its removal. */
export const ChangeItem = z.object({ department: z.uuid(), checked: z.boolean(), note: Note, products: Products.optional(), teams: z.array(TeamChange).max(10).optional(), remove: z.boolean().optional() });
export const Proposal = z.object({ brief: z.string().trim().min(1).max(1500), items: z.array(z.union([NewItem, ChangeItem])).min(1).max(20) });

export type NewItem = z.infer<typeof NewItem>;
export type ChangeItem = z.infer<typeof ChangeItem>;
/* What the CEO's click sends: the ticked items, without the tick. */
/* about: a new description of a department that is there, such as the measures its own pipeline report counts; set by
   the people who run it, or by its head on their word. */
export const BuildItem = z.union([
  NewItem.omit({ checked: true }).extend({ note: Note.default('') }),
  ChangeItem.omit({ checked: true }).extend({ note: Note.default(''), about: z.string().trim().max(160).optional() }),
]);
export type BuildItem = z.infer<typeof BuildItem>;

type NewPart = Omit<NewItem, 'checked'>;
type ChangePart = Omit<ChangeItem, 'checked'>;
export type StructureItem = NewPart | ChangePart;

export const isNew = <T extends StructureItem>(item: T): item is Extract<T, NewPart> => 'template' in item;

/* The tasks a department and its products can hold: those in it, and for a product those in the department holding it.
   A task's product is always in the task's department, which creating a task checks and nothing changes later, so the
   department's index finds them all and the company's other tasks are not read. */
export const inPlaces = (companyId: string, dept: { parentId: string | null }, inside: string[]) =>
  and(eq(tasks.companyId, companyId), inArray(tasks.departmentId, dept.parentId ? [...inside, dept.parentId] : inside));

type DeptRow = typeof departments.$inferSelect;

async function checkItemTeams(db: Db, companyId: string, dept: DeptRow, list: TeamChange[] = []): Promise<string | null> {
  const ids = list.flatMap(t => (typeof t === 'string' ? [] : [t.id]));
  if (!ids.length) return null;
  const existing = new Set(
    (await db.select(idOnly(teams)).from(teams).where(and(eq(teams.companyId, companyId), eq(teams.departmentId, dept.id)))).map(t => t.id),
  );
  const missing = ids.find(id => !existing.has(id));
  return missing ? `There is no sub-unit with id ${missing} in ${deptName(dept)}. Call company to see the current ids.` : null;
}

async function checkChangeItem(db: Db, companyId: string, all: DeptRow[], byId: Map<string, DeptRow>, item: ChangePart): Promise<string | null> {
  const dept = byId.get(item.department);
  if (!dept) return `There is no department with id ${item.department}. Call company to see the current ids.`;
  if (!item.remove) return checkItemTeams(db, companyId, dept, item.teams);
  if (dept.templateKey === 'operations') return 'Operations is always there and cannot be removed.';
  const inside = [dept.id, ...all.filter(d => d.parentId === dept.id).map(d => d.id)];
  const staffed = await db
    .select(idOnly(agents))
    .from(agents)
    .where(and(or(inArray(agents.departmentId, inside), inArray(agents.productId, inside)), isNull(agents.removedAt)));
  if (staffed.length) return `${deptName(dept)} has agents and cannot be removed.`;
  const teamIds = (await db.select(idOnly(teams)).from(teams).where(inArray(teams.departmentId, inside))).map(t => t.id);
  const places = [...inside, ...teamIds];
  const [person] = await db
    .select(idOnly(personAccess))
    .from(personAccess)
    .where(or(inArray(personAccess.departmentId, inside), teamIds.length ? inArray(personAccess.teamId, teamIds) : undefined));
  if (person) return `People work in ${deptName(dept)}; move them first.`;
  const [key] = await db.select(idOnly(subscriptions)).from(subscriptions).where(and(inArray(subscriptions.targetId, places), isNull(subscriptions.removedAt)));
  if (key) return `An API key serves ${deptName(dept)}; point it elsewhere first.`;
  const [busy] = await db
    .select(idOnly(tasks))
    .from(tasks)
    .where(and(inPlaces(companyId, dept, inside), or(inArray(tasks.departmentId, inside), inArray(tasks.productId, inside)), notInArray(tasks.status, ['done', 'cancelled'])))
    .limit(1);
  if (busy) return `${deptName(dept)} has open tasks; finish or cancel them first.`;
  return null;
}

function checkNewItem(items: StructureItem[], unnamed: Set<string | null>, hasOperations: boolean, item: NewPart): string | null {
  if (item.template === 'operations') {
    if (hasOperations) return 'The company already has Operations; there is only one.';
    if (items.filter(i => isNew(i) && i.template === 'operations').length > 1) return 'Operations appears twice; there is only one.';
  }
  if (item.name) return null;
  const name = TEMPLATE_TEXT[item.template].name;
  if (unnamed.has(item.template)) return `${name} is already there. Give the new one its own name, such as "${name} Europe".`;
  unnamed.add(item.template);
  return null;
}

/* What is wrong with these items against the company as it is, in plain English for the agent to fix, or null. */
export async function checkItems(db: Db, companyId: string, items: StructureItem[]): Promise<string | null> {
  const all = await db.select().from(departments).where(eq(departments.companyId, companyId));
  const byId = new Map(all.map(d => [d.id, d]));
  const unnamed = new Set(all.filter(d => d.templateKey && !d.name).map(d => d.templateKey));
  const hasOperations = all.some(d => d.templateKey === 'operations');

  for (const item of items) {
    const problem = isNew(item) ? checkNewItem(items, unnamed, hasOperations, item) : await checkChangeItem(db, companyId, all, byId, item);
    if (problem) return problem;
  }
  return null;
}
