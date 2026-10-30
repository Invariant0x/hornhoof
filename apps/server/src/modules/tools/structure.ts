import { TEMPLATE_KEYS } from '@hornhoof/protocol';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { agents, departments } from '../../db/schema.js';
import { deptName, TEMPLATE_TEXT } from '../departments/templates.js';

const Name = z.string().trim().min(1).max(60);
const Note = z.string().max(160);
const Products = z.array(Name).max(10);

/* A department to create from a template. name only when the template is used a second time, such as "Sales Europe". */
export const NewItem = z.object({ template: z.enum(TEMPLATE_KEYS), name: Name.optional(), checked: z.boolean(), note: Note, products: Products.optional() });
/* A change to a department that exists: products to add under it, or its removal. */
export const ChangeItem = z.object({ department: z.uuid(), checked: z.boolean(), note: Note, products: Products.optional(), remove: z.boolean().optional() });
export const Proposal = z.object({ brief: z.string().trim().min(1).max(1500), items: z.array(z.union([NewItem, ChangeItem])).min(1).max(20) });

export type NewItem = z.infer<typeof NewItem>;
export type ChangeItem = z.infer<typeof ChangeItem>;
export type StructureItem = NewItem | ChangeItem;

export const isNew = (item: StructureItem): item is NewItem => 'template' in item;

/* What is wrong with these items against the company as it is, in plain English for the agent to fix, or null. */
export async function checkItems(db: Db, companyId: string, items: StructureItem[]): Promise<string | null> {
  const all = await db.select().from(departments).where(eq(departments.companyId, companyId));
  const byId = new Map(all.map(d => [d.id, d]));
  const unnamed = new Set(all.filter(d => d.templateKey && !d.name).map(d => d.templateKey));
  const hasOperations = all.some(d => d.templateKey === 'operations');

  for (const item of items) {
    if (!isNew(item)) {
      const dept = byId.get(item.department);
      if (!dept) return `There is no department with id ${item.department}. Call company to see the current ids.`;
      if (!item.remove) continue;
      if (dept.templateKey === 'operations') return 'Operations is always there and cannot be removed.';
      const inside = [dept.id, ...all.filter(d => d.parentId === dept.id).map(d => d.id)];
      const staffed = await db.select({ id: agents.id }).from(agents).where(inArray(agents.departmentId, inside));
      if (staffed.length) return `${deptName(dept)} has agents and cannot be removed.`;
      continue;
    }
    if (item.template === 'operations') {
      if (hasOperations) return 'The company already has Operations; there is only one.';
      if (items.filter(i => isNew(i) && i.template === 'operations').length > 1) return 'Operations appears twice; there is only one.';
    }
    if (item.name) continue;
    const name = TEMPLATE_TEXT[item.template].name;
    if (unnamed.has(item.template)) return `${name} is already there. Give the new one its own name, such as "${name} Europe".`;
    unnamed.add(item.template);
  }
  return null;
}
