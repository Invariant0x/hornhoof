import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, assistants, departments, people, personAccess, teams, type AssistantProgram } from '../../db/schema.js';
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
  /* For an assistant: whose it is, its program, where it is woken, and when its key was made, never the key itself. */
  assistant: AssistantView | null;
};

/* agent: the assistant's own agent and the plan it thinks on, once its owner picked one. */
export type AssistantView = {
  owner: { id: string; name: string };
  program: AssistantProgram;
  eventsUrl: string | null;
  skillsUrl: string | null;
  agent: { id: string; plan: string | null } | null;
  key: { createdAt: string } | null;
};

const owners = alias(people, 'owners');

/* The assistants among these people, by their id. */
async function assistantViews(db: Db, ids: string[]): Promise<Map<string, AssistantView>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: people.id, ownerId: owners.id, ownerName: owners.name, program: assistants.program, eventsUrl: assistants.eventsUrl, skillsUrl: assistants.skillsUrl, agentId: agents.id, plan: agents.subscriptionId, keyCreatedAt: assistants.keyCreatedAt })
    .from(people)
    .innerJoin(owners, eq(owners.id, people.assistantOf))
    .innerJoin(assistants, eq(assistants.personId, people.id))
    .leftJoin(agents, eq(agents.id, assistants.agentId))
    .where(inArray(people.id, ids));
  return new Map(
    rows.map(r => [
      r.id,
      { owner: { id: r.ownerId, name: r.ownerName }, program: r.program, eventsUrl: r.eventsUrl, skillsUrl: r.skillsUrl, agent: r.agentId ? { id: r.agentId, plan: r.plan } : null, key: r.keyCreatedAt ? { createdAt: r.keyCreatedAt.toISOString() } : null },
    ]),
  );
}

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
  const helpers = await assistantViews(db, rows.map(p => p.id));
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
      assistant: helpers.get(p.id) ?? null,
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
