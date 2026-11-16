import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hiddenParty, knowsAgentId, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agents, companies, departments, INBOX_MODES, LETTER_KINDS, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { agentFor, type AgentRow } from '../agents/find.js';
import { mayChangeRules } from '../departments/approval-policy.js';
import { agentParty, HORNHOOF, personParty, type MessageParty } from '../events/parties.js';
import { seesTask } from '../tasks/sight.js';
import { inboxChanged, inboxModeOf, letterTotal, lettersPage, logMarked, markMail, picksLetters, readByPerson, unreadCount, type InboxRow } from './inbox.js';
import { pump } from './queue.js';

const IdParams = z.strictObject({ id: z.uuid() });
const ModeBody = z.strictObject({ mode: z.enum(INBOX_MODES).nullable() });
const CompanyModeBody = z.strictObject({ mode: z.enum(INBOX_MODES) });
/* A person reads the newest letters first, this many at once, and older ones a page at a time. */
const PAGE = 50;
const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.uuid().optional() });
const ReadBody = z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) }), z.strictObject({ all: z.literal(true) })]);

/* Any of the employee's letters marked read or done by a choice of them, with why: kind, source, task and a moment apply
   together, on these ids or on all. */
const MarkBody = z.strictObject({
  status: z.enum(['read', 'done']),
  ids: z.array(z.uuid()).min(1).max(200).optional(),
  kind: z.enum(LETTER_KINDS).optional(),
  source: z.string().trim().min(1).max(64).optional(),
  task: z.number().int().positive().optional(),
  receivedBefore: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().trim().min(1).max(500),
});

const NOT_YOURS = 'Only the CEO, the CEO delegate or the owner of its department changes how this employee takes its mail.';
const NOT_YOURS_TO_MARK = 'Only the CEO, the CEO delegate or the owner of its department marks this employee\'s letters.';
const NOT_CEOS = "Only the CEO and the CEO delegate mark another employee's letters this way.";

/* Who sent each letter as this person reads it: an employee they do not know of, or one no longer in the company, is
   "Employee", as in the window. */
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
    return parties.get(id) ?? { kind: row.senderKind, id: null, name: row.senderKind === 'agent' ? 'Employee' : row.senderName, role: null, department: null };
  };
}

/* The title of each letter's task when this person sees that task, which its link then opens; else its number alone. */
async function titlesOf(ctx: Ctx, viewer: AgentViewer, rows: InboxRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap(r => (r.taskId ? [r.taskId] : [])))];
  const found = ids.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  return new Map(found.filter(t => seesTask(viewer, t)).map(t => [t.id, t.title]));
}

const taskOf = (row: InboxRow, titles: Map<string, string>) => {
  if (row.taskNumber === null) return null;
  const title = row.taskId ? titles.get(row.taskId) : undefined;
  return { id: title !== undefined ? row.taskId : null, number: row.taskNumber, title: title ?? null };
};

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
    task: taskOf(row, titles),
    receivedAt: row.createdAt.toISOString(),
    text: row.text,
    unread: row.status === 'unread',
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
    const { limit = PAGE, before } = InboxQuery.parse(req.query);
    /* Opening the inbox marks nothing: a letter stays unread for the employee until it or a person marks it. */
    const page = await lettersPage(db, agent.id, { before, limit });
    const mode = await inboxModeOf(db, agent.id);
    const may = await changesRulesOf(ctx, me, agent);
    return {
      unreadCount: await unreadCount(db, agent.id),
      total: await letterTotal(db, agent.id),
      letters: await lettersFor(ctx, me, page.letters),
      more: page.more,
      mode: mode.own,
      inheritedMode: mode.inherited,
      effectiveMode: mode.effective,
      /* Who changes how its letters come marks them read too. */
      canChangeMode: may,
      canMarkRead: may,
    };
  });
  app.post('/api/agents/:id/inbox/read', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const body = ReadBody.parse(req.body);
    if (!(await changesRulesOf(ctx, me, agent))) throw new ApiError(403, 'forbidden', NOT_YOURS_TO_MARK, 'not_owner');
    const unread = await readByPerson(db, agent.id, 'all' in body ? 'all' : body.ids);
    if (unread === null) throw new ApiError(404, 'not_found', 'Some of these letters are not in this employee\'s inbox.', 'letter_unknown');
    await inboxChanged(ctx, agent.id);
    return { unreadCount: unread };
  });
  /* The CEO and the CEO delegate mark any of the employee's letters read or done, by a choice of them; the employee's log
     tells who, why and how many. Not the owner of its department, whose buttons mark its letters read as before, and not
     an assistant's key, which opens its own routes alone. */
  app.post('/api/agents/:id/inbox/mark', async req => {
    const { me, agent } = await agentFor(ctx, req);
    if (!actsAsCeo(me)) throw new ApiError(403, 'forbidden', NOT_CEOS, 'not_owner');
    const { status, reason, receivedBefore, ...rest } = MarkBody.parse(req.body);
    const pick = { ...rest, ...(receivedBefore ? { receivedBefore: new Date(receivedBefore) } : {}) };
    if (!picksLetters(pick)) throw new ApiError(400, 'validation', 'Name the letters: ids, or a kind, a source, a task or receivedBefore.');
    const marked = await markMail(db, agent.id, pick, status);
    if (marked === null) throw new ApiError(404, 'not_found', 'Some of these letters are not in this employee\'s inbox.', 'letter_unknown');
    await logMarked(ctx, agent, { party: { ...(await personParty(ctx, me.companyId, me.id)), kind: 'person', id: me.id }, reason }, status, marked);
    await inboxChanged(ctx, agent.id);
    return { marked, unreadCount: await unreadCount(db, agent.id) };
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
    /* A product's id is not a department's: its mode is its department's. */
    const [department] = await db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId), isNull(departments.parentId)));
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
