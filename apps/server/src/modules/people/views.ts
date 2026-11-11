import { asc, inArray } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { departments, people, personAccess, teams } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';

export const WHOLE_COMPANY = 'Whole company';

export type AccessView = { whole: boolean; departments: { id: string; name: string }[]; teams: { id: string; name: string; departmentId: string }[] };

export type PersonView = {
  id: string;
  name: string;
  email: string | null;
  title: string;
  status: Person['status'];
  isOwner: boolean;
  isCeoDelegate: boolean;
  access: AccessView;
  /* Who they are in Telegram, for the heads' bots: a username, the account's number, or both once a bot met them. */
  telegram: { username: string | null; id: number | null } | null;
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
  const telegram = new Map(
    rows.length
      ? (await db.select({ id: people.id, username: people.telegramUsername, number: people.telegramUserId }).from(people).where(inArray(people.id, rows.map(p => p.id)))).map(t => [t.id, t])
      : [],
  );
  return rows.map(p => {
    const tg = telegram.get(p.id);
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
      isCeoDelegate: p.isCeoDelegate,
      telegram: tg && (tg.username || tg.number) ? { username: tg.username, id: tg.number } : null,
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
