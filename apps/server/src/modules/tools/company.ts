import { DEPARTMENT_TEMPLATES } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { accessesOf } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, companies, departments, googleSheets, nodes, people, subscriptions, teams, type AgentOverrides } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { liveNode } from '../nodes/nodes.js';
import { agreed } from '../subscriptions/views.js';
import { employeeOrder } from '../agents/order.js';
import { deptName, TEMPLATE_TEXT } from '../departments/templates.js';
import type { Templates } from '../templates/load.js';
import { servesWholeCompany } from './staff.js';

const ownText = (overrides: AgentOverrides): boolean => Boolean(overrides.base?.trim() || Object.values(overrides.skills ?? {}).some(text => text.trim()));
const repositoryOf = (d: { repoUrl: string | null; repoBranch: string | null }) => (d.repoUrl ? { url: d.repoUrl, branch: d.repoBranch ?? 'main' } : null);

/* The people an agent may take orders from: those who see the whole company, and those who run departments, each with the
   departments they run in full. Someone given only a sub-unit or a product runs no department, so is not one of them. */
async function leadersOf(db: Db, companyId: string, depts: (typeof departments.$inferSelect)[]) {
  const rows = await db
    .select({ id: people.id, name: people.name, title: people.title, scopeKind: people.scopeKind })
    .from(people)
    .where(and(eq(people.companyId, companyId), ne(people.status, 'disabled'), eq(people.isAgent, false)))
    .orderBy(asc(people.createdAt));
  const access = await accessesOf(db, rows.filter(p => p.scopeKind !== 'company'));
  const leaders: { name: string; title: string; runs?: string[] }[] = [];
  for (const p of rows) {
    if (p.scopeKind === 'company') leaders.push({ name: p.name, title: p.title });
    else {
      const owns = access.get(p.id)!.owns ?? new Set<string>();
      const runs = depts.filter(d => owns.has(d.id)).map(deptName);
      if (runs.length) leaders.push({ name: p.name, title: p.title, runs });
    }
  }
  return leaders;
}

/* What the company tool shows an agent: names and roles, never emails or keys. */
export async function companyView(db: Db, templates: Templates, companyId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const depts = await db.select().from(departments).where(eq(departments.companyId, companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
  const leaders = await leadersOf(db, companyId, depts);
  const owners = new Map((await db.select({ id: people.id, scopeKind: people.scopeKind }).from(people)).map(p => [p.id, p.scopeKind]));
  const subs = await db.select().from(subscriptions).where(and(eq(subscriptions.companyId, companyId), isNull(subscriptions.removedAt)));
  /* What each plan's machines are signed in to: agents get the tier, never the address. */
  const told = subs.length ? await db.select({ subscriptionId: nodes.subscriptionId, account: nodes.account }).from(nodes).where(and(inArray(nodes.subscriptionId, subs.map(s => s.id)), liveNode)) : [];
  const tierOf = (id: string) => agreed(told.filter(n => n.subscriptionId === id && n.account).map(n => n.account!)).tier;
  const staff = await db.select().from(agents).where(and(eq(agents.companyId, companyId), ne(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  const allTeams = await db.select().from(teams).where(eq(teams.companyId, companyId)).orderBy(asc(teams.createdAt));
  /* Each department's employees, so a head knows its team: role, product and what it runs on. The id is what create_task
     takes as the executor; the role id names the role it holds. */
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
        teamId: a.teamId,
        provider: subs.find(s => s.id === a.subscriptionId)?.provider ?? null,
        model: a.model || null,
        /* Off for now: it takes no work until a person switches it on. */
        on: !a.switchedOffAt,
        /* A person gave it text of its own over its role's, which may narrow the work it takes; the text stays on its card. */
        ownText: ownText(a.overrides),
      }));
  const [gs] = await db.select(idOnly(googleSheets)).from(googleSheets).where(eq(googleSheets.companyId, companyId));
  return {
    name: company?.name ?? '',
    brief: company?.brief ?? '',
    googleSheets: { connected: Boolean(gs) },
    people: leaders,
    departments: depts
      .filter(d => !d.parentId)
      .map(d => ({
        id: d.id,
        name: deptName(d),
        template: d.templateKey,
        about: d.about,
        /* Where a task's code goes: its product's repository, else the department's own. Never a token. */
        repository: repositoryOf(d),
        products: depts.filter(p => p.parentId === d.id).map(p => ({ id: p.id, name: deptName(p), repository: repositoryOf(p) })),
        teams: allTeams.filter(t => t.departmentId === d.id).map(t => ({ id: t.id, name: t.name, urgentOnly: t.urgentOnly, turnkey: t.turnkey })),
        employees: employeesOf(d),
      })),
    subscriptions: subs.map(s => ({
      provider: s.provider,
      kind: s.kind,
      servesWholeCompany: servesWholeCompany(s, owners.get(s.ownerPersonId)),
      tier: tierOf(s.id),
    })),
    templates: DEPARTMENT_TEMPLATES.map(t => ({ key: t.key, ...TEMPLATE_TEXT[t.key], alwaysOn: t.always })),
  };
}
