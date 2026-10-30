import { asc, inArray } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { departments, personAccess, teams } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';

export const WHOLE_COMPANY = 'Whole company';

export type AccessView = { whole: boolean; departments: { id: string; name: string }[]; teams: { id: string; name: string; departmentId: string }[] };

export type PersonView = {
  id: string;
  name: string;
  email: string;
  title: string;
  status: Person['status'];
  isOwner: boolean;
  access: AccessView;
};

/* Listed places come in the order the map shows departments and teams. */
export async function personViews(db: Db, rows: Person[]): Promise<PersonView[]> {
  const listed = rows.filter(p => p.scopeKind !== 'company').map(p => p.id);
  const access = listed.length ? await db.select().from(personAccess).where(inArray(personAccess.personId, listed)) : [];
  const depts = await db
    .select({ id: departments.id, name: departments.name, templateKey: departments.templateKey })
    .from(departments)
    .orderBy(asc(departments.position), asc(departments.createdAt));
  const allTeams = await db.select({ id: teams.id, name: teams.name, departmentId: teams.departmentId }).from(teams).orderBy(asc(teams.stage), asc(teams.createdAt));
  return rows.map(p => {
    const mine = access.filter(a => a.personId === p.id);
    const deptIds = new Set(mine.map(a => a.departmentId));
    const teamIds = new Set(mine.map(a => a.teamId));
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      title: p.title,
      status: p.status,
      isOwner: p.isOwner,
      access: {
        whole: p.scopeKind === 'company',
        departments: depts.filter(d => deptIds.has(d.id)).map(d => ({ id: d.id, name: deptName(d) })),
        teams: allTeams.filter(t => teamIds.has(t.id)),
      },
    };
  });
}

export async function personView(db: Db, row: Person): Promise<PersonView> {
  return (await personViews(db, [row]))[0]!;
}
