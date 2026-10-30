import { DEPARTMENT_TEMPLATES } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { companies, departments, people, subscriptions } from '../../db/schema.js';
import { deptName, TEMPLATE_TEXT } from '../departments/templates.js';
import { servesWholeCompany } from './staff.js';

/* What the company tool shows an agent: names and roles, never emails or keys. */
export async function companyView(db: Db, companyId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const leaders = await db
    .select({ name: people.name, title: people.title })
    .from(people)
    .where(and(eq(people.companyId, companyId), eq(people.scopeKind, 'company'), ne(people.status, 'disabled')))
    .orderBy(asc(people.createdAt));
  const depts = await db.select().from(departments).where(eq(departments.companyId, companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
  const owners = new Map((await db.select({ id: people.id, scopeKind: people.scopeKind }).from(people)).map(p => [p.id, p.scopeKind]));
  const subs = await db.select().from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNull(subscriptions.removedAt)));
  return {
    name: company?.name ?? '',
    brief: company?.brief ?? '',
    people: leaders,
    departments: depts
      .filter(d => !d.parentId)
      .map(d => ({
        id: d.id,
        name: deptName(d),
        template: d.templateKey,
        about: d.about,
        products: depts.filter(p => p.parentId === d.id).map(p => ({ id: p.id, name: deptName(p) })),
      })),
    subscriptions: subs.map(s => ({
      provider: s.provider,
      kind: s.kind,
      servesWholeCompany: servesWholeCompany(s, owners.get(s.ownerPersonId)),
    })),
    templates: DEPARTMENT_TEMPLATES.map(t => ({ key: t.key, ...TEMPLATE_TEXT[t.key], alwaysOn: t.always })),
  };
}
