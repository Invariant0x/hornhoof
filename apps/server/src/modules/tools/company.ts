import { DEPARTMENT_TEMPLATES } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, companies, departments, people, subscriptions } from '../../db/schema.js';
import { employeeOrder } from '../agents/order.js';
import { deptName, TEMPLATE_TEXT } from '../departments/templates.js';
import type { Templates } from '../templates/load.js';
import { servesWholeCompany } from './staff.js';

/* What the company tool shows an agent: names and roles, never emails or keys. */
export async function companyView(db: Db, templates: Templates, companyId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const leaders = await db
    .select({ name: people.name, title: people.title })
    .from(people)
    .where(and(eq(people.companyId, companyId), eq(people.scopeKind, 'company'), ne(people.status, 'disabled')))
    .orderBy(asc(people.createdAt));
  const depts = await db.select().from(departments).where(eq(departments.companyId, companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
  const owners = new Map((await db.select({ id: people.id, scopeKind: people.scopeKind }).from(people)).map(p => [p.id, p.scopeKind]));
  const subs = await db.select().from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNull(subscriptions.removedAt)));
  const staff = await db.select().from(agents).where(and(eq(agents.companyId, companyId), ne(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  /* Each department's employees, so a head knows its team: role, product and what it runs on. The id is what create_task
     takes as the executor, the role id what it takes as a gate. */
  const employeesOf = (dept: (typeof depts)[number]) =>
    staff
      .filter(a => a.departmentId === dept.id)
      .sort(employeeOrder(templates, dept.templateKey))
      .map(a => ({
        id: a.id,
        name: a.name,
        roleId: a.roleKey,
        role: (a.roleKey && templates.roles.get(a.roleKey)?.title.en) || null,
        kind: a.kind,
        product: (a.productId && deptName(depts.find(p => p.id === a.productId)!)) || null,
        provider: subs.find(s => s.id === a.subscriptionId)?.provider ?? null,
        model: a.model || null,
      }));
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
        employees: employeesOf(d),
      })),
    subscriptions: subs.map(s => ({
      provider: s.provider,
      kind: s.kind,
      servesWholeCompany: servesWholeCompany(s, owners.get(s.ownerPersonId)),
    })),
    templates: DEPARTMENT_TEMPLATES.map(t => ({ key: t.key, ...TEMPLATE_TEXT[t.key], alwaysOn: t.always })),
  };
}
