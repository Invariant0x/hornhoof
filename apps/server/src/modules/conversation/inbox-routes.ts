import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hiddenParty, knowsAgentId, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agents, companies, departments, INBOX_MODES, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentFor, type AgentRow } from '../agents/find.js';
import { mayChangeRules } from '../departments/approval-policy.js';
import { agentParty, HORNHOOF, personParty, type MessageParty } from '../events/parties.js';
import { seesTask } from '../tasks/sight.js';
import { inboxChanged, inboxModeOf, inboxView, readByPerson, type InboxRow } from './inbox.js';
import { pump } from './queue.js';

const IdParams = z.strictObject({ id: z.uuid() });
const ModeBody = z.strictObject({ mode: z.enum(INBOX_MODES).nullable() });
const CompanyModeBody = z.strictObject({ mode: z.enum(INBOX_MODES) });
const InboxQuery = z.object({ status: z.enum(['unread', 'read', 'all']).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), before: z.uuid().optional() });
const ReadBody = z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }), z.strictObject({ all: z.literal(true) })]);

const NOT_YOURS = 'Only the CEO, the CEO delegate or the owner of its department changes how this employee takes its mail.';
const NOT_YOURS_TO_MARK = 'Only the CEO, the CEO delegate or the owner of its department marks this employee\'s letters.';

/* Who sent each letter as this person reads it: an employee they do not know of is "Employee", as in the window. */
async function sendersOf(ctx: Ctx, viewer: AgentViewer, companyId: string, rows: InboxRow[]): Promise<(row: InboxRow) => MessageParty> {
  const agentIds = [...new Set(rows.flatMap(r => (r.senderAgentId ? [r.senderAgentId] : [])))];
  const personIds = [...new Set(rows.flatMap(r => (r.senderPersonId ? [r.senderPersonId] : [])))];
  const parties = new Map<string, MessageParty>();
  for (const id of agentIds) {
    const party = await agentParty(ctx, companyId, id).catch(() => null);
    if (party) parties.set(id, knowsAgentId(viewer, id) ? party : hiddenParty(party));
  }
  for (const id of personIds) {
    const party = await personParty(ctx, companyId, id).catch(() => null);
    if (party) parties.set(id, party);
  }
  return row => {
    const id = row.senderAgentId ?? row.senderPersonId;
    if (row.senderKind === 'hornhoof' || !id) return HORNHOOF;
    return parties.get(id) ?? { kind: row.senderKind, id: null, name: row.senderName, role: null, department: null };
  };
}

/* The title of each letter's task when this person sees that task; else its number alone. */
async function titlesOf(ctx: Ctx, viewer: AgentViewer, rows: InboxRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap(r => (r.taskId ? [r.taskId] : [])))];
  const found = ids.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  return new Map(found.filter(t => seesTask(viewer, t)).map(t => [t.id, t.title]));
}

/* The letters as the tab shows them. What the employee dealt with is read to a person: done is the employee's own mark. */
async function lettersFor(ctx: Ctx, me: Person, rows: InboxRow[]) {
  const viewer = await viewerOf(ctx.db, me);
  const sender = await sendersOf(ctx, viewer, me.companyId, rows);
  const titles = await titlesOf(ctx, viewer, rows);
  return rows.map(row => ({
    id: row.id,
    sender: sender(row),
    kind: row.kind,
    source: row.source,
    task: row.taskNumber !== null ? { number: row.taskNumber, title: (row.taskId && titles.get(row.taskId)) || null } : null,
    at: row.createdAt.toISOString(),
    text: row.text,
    status: row.status === 'unread' ? ('unread' as const) : ('read' as const),
  }));
}

/* The CEO, the CEO delegate and the owner of the employee's department change its rules; the orchestrator's are the CEO's. */
const changesRulesOf = async (ctx: Ctx, me: Person, agent: AgentRow) => actsAsCeo(me) || (agent.departmentId !== null && (await mayChangeRules(ctx.db, me, agent.departmentId)));

/* An employee's inbox opens to whoever opens the employee: the CEO and the CEO delegate, and the owner of its department
   on any plan; another department's owner gets 403. Its mode changes with the CEO, the CEO delegate or that owner, the
   orchestrator's with the CEO and the delegate alone; the company's with them, and a department's with its owner too. */
export function inboxRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.get('/api/agents/:id/inbox', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const { status, ...rest } = InboxQuery.parse(req.query);
    /* Opening the inbox marks nothing: a letter stays unread for the employee until it or a person marks it. */
    const view = await inboxView(db, agent.id, { status: status === 'read' ? 'seen' : (status ?? 'all'), ...rest });
    return { unread: view.unread, letters: await lettersFor(ctx, me, view.letters), mode: await inboxModeOf(db, agent.id), canChange: await changesRulesOf(ctx, me, agent) };
  });
  app.post('/api/agents/:id/inbox/read', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const body = ReadBody.parse(req.body);
    if (!(await changesRulesOf(ctx, me, agent))) throw new ApiError(403, 'forbidden', NOT_YOURS_TO_MARK, 'not_owner');
    const unread = await readByPerson(db, agent.id, 'all' in body ? 'all' : body.ids);
    if (unread === null) throw new ApiError(404, 'not_found', 'Some of these letters are not in this employee\'s inbox.', 'letter_unknown');
    await inboxChanged(ctx, agent.id);
    return { unread };
  });
  app.put('/api/agents/:id/inbox-mode', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const { mode } = ModeBody.parse(req.body);
    if (!(await changesRulesOf(ctx, me, agent))) throw new ApiError(403, 'forbidden', NOT_YOURS, 'not_owner');
    await db.update(agents).set({ inboxMode: mode }).where(and(eq(agents.id, agent.id), eq(agents.companyId, me.companyId)));
    await pump(ctx, agent.id);
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { mode: await inboxModeOf(db, agent.id) };
  });
  app.put('/api/departments/:id/inbox-mode', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { mode } = ModeBody.parse(req.body);
    const [department] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!department) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    if (!(await mayChangeRules(db, me, department.id))) throw new ApiError(403, 'forbidden', "Only this department's owner, the CEO or the CEO delegate changes how its employees take their mail.", 'not_owner');
    await db.update(departments).set({ inboxMode: mode }).where(eq(departments.id, department.id));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { mode };
  });
  app.put('/api/company/inbox-mode', async req => {
    const me = await requirePerson(req, db);
    const { mode } = CompanyModeBody.parse(req.body);
    if (!actsAsCeo(me)) throw new ApiError(403, 'forbidden', 'Only the CEO or the CEO delegate changes how the company takes its mail.', 'not_owner');
    await db.update(companies).set({ inboxMode: mode }).where(eq(companies.id, me.companyId));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { mode };
  });
}
