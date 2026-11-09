import { randomUUID } from 'node:crypto';
import { PROGRAM_OPERATOR_ROLE, ProgramKey, type OperatorQuestion, type ProgramInputResult } from '@hornhoof/protocol/program-operator';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, departments, jobs, programOperatorCases, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentParty } from '../events/parties.js';
import { identityOf } from '../nodes/hub.js';
import { logTurnFact } from '../tasks/turn-log.js';
import type { OperatorCaller } from './authorization.js';
import { operatorNotification } from './notifications.js';
import { pictureSecrets, renderPicture, storeCasePicture } from './pictures.js';
import { requestProgramInput, requestProgramView, type ProgramAt } from './rpc.js';
import { operatorTransaction } from './transactions.js';

/* Operations, by the role each holds in it: the head of Operations and the program operator. */
export const OPERATIONS_ROLES: Record<string, 'head' | 'worker'> = { 'OPS-HEAD': 'head', [PROGRAM_OPERATOR_ROLE]: 'worker' };
const HIDDEN = '[hidden]';
const SECRET_MIN = 8;

type Agent = typeof agents.$inferSelect;
type Job = typeof jobs.$inferSelect;
type Program = ProgramAt & { job: Job; name: string };
export type ViewInput = { employee: string };
export type KeysInput = { employee: string; snapshot: string; keys?: string[]; text?: string; reason: string; decision?: 'allowed' | 'denied' };

export const accessRefused = () => new ApiError(403, 'forbidden', "Only the orchestrator and Operations look at another employee's program and type into it.", 'agent_not_ready');
const unavailable = (reason: string) => new ApiError(409, 'unavailable', `The program screen is unavailable: ${reason}.`, 'programs_unavailable');

export async function inOperations(db: Db, department: typeof departments.$inferSelect | null): Promise<boolean> {
  if (!department) return false;
  if (department.templateKey === 'operations') return true;
  const [parent] = department.parentId ? await db.select().from(departments).where(eq(departments.id, department.parentId)) : [];
  return parent?.templateKey === 'operations';
}

/* Whether this employee holds a role of Operations in it, whatever it runs now. */
export async function ofOperations(db: Db, agent: Agent, department: typeof departments.$inferSelect | null): Promise<boolean> {
  return Boolean(agent.roleKey) && OPERATIONS_ROLES[agent.roleKey!] === agent.kind && await inOperations(db, department);
}

/* Operations on duty, the program operator before the head of Operations. */
export async function operationsStaff(ctx: Ctx, companyId: string): Promise<Agent[]> {
  const ops = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const below = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.parentId, ops)));
  const staff = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), or(inArray(agents.departmentId, ops), inArray(agents.departmentId, below)), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  return [PROGRAM_OPERATOR_ROLE, 'OPS-HEAD'].flatMap(role => staff.filter(agent => agent.roleKey === role && OPERATIONS_ROLES[role] === agent.kind));
}

/* The advertised role is no authority: the current employee, its department and its running turn are. The orchestrator answers
   for nothing standing still anywhere, and Operations keep the programs going, so they act on any employee's program. */
export async function authorizeAccess(ctx: Ctx, caller: OperatorCaller): Promise<Agent> {
  const [found] = await ctx.db.select({ me: agents, department: departments }).from(agents)
    .innerJoin(jobs, eq(jobs.id, caller.id)).leftJoin(departments, and(eq(departments.id, agents.departmentId), eq(departments.companyId, caller.companyId)))
    .where(and(eq(agents.id, caller.agentId), eq(agents.companyId, caller.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt), eq(jobs.agentId, agents.id), eq(jobs.companyId, caller.companyId), eq(jobs.status, 'running')));
  if (!found) throw accessRefused();
  if (found.me.kind !== 'orchestrator' && !await ofOperations(ctx.db, found.me, found.department)) throw accessRefused();
  return found.me;
}

/* What reached a node: a turn that started there, or one that went out and has not ended. */
const reachedNode = or(isNotNull(jobs.startedAt), inArray(jobs.status, ['queued', 'running']));

/* The employee's program where its last turn on its plan went, of any department and on any plan. Never the caller's own. */
async function programOf(ctx: Ctx, me: Agent, employee: string): Promise<Program> {
  const [target] = await ctx.db.select().from(agents).where(and(eq(agents.id, employee), eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
  if (!target || target.id === me.id) throw accessRefused();
  const [found] = await ctx.db.select({ agent: agents, job: jobs, sub: subscriptions }).from(agents)
    .innerJoin(jobs, and(eq(jobs.agentId, agents.id), eq(jobs.subscriptionId, agents.subscriptionId)))
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(agents.id, target.id), eq(jobs.companyId, me.companyId), eq(jobs.kind, 'conversation'), eq(subscriptions.companyId, me.companyId), reachedNode))
    .orderBy(desc(jobs.createdAt)).limit(1);
  const node = found && identityOf(found.sub, found.job.nodeId);
  if (!found || !node) throw unavailable('no_program');
  return { agentId: found.agent.id, node, job: found.job, name: found.agent.name };
}

/* Only the values of secrets are masked; the rest of the screen, the question and the input line are as the program shows them. */
export async function readProgramView(ctx: Ctx, caller: OperatorCaller, input: ViewInput) {
  const me = await authorizeAccess(ctx, caller);
  const program = await programOf(ctx, me, input.employee);
  const view = await requestProgramView(ctx, program);
  if (!view || view.result !== 'ok' || !view.snapshot) throw unavailable(view?.reason ?? 'node_unavailable');
  const secrets = await pictureSecrets(ctx, me.companyId);
  const { rendered } = renderPicture(view, secrets);
  await keepForCase(ctx, caller, program, rendered.png);
  return {
    employee: program.agentId, name: program.name, job: view.jobId, instance: view.instance, snapshot: view.snapshot, state: view.state,
    tool: view.tool, question: maskedQuestion(view.question, secrets), input: view.input, undelivered: view.undelivered, png: rendered.png, text: rendered.text,
  };
}

/* Text goes in as a paste, then the keys, into the program the fresh snapshot showed. Any key goes, Ctrl+U and Escape too, and
   any question is answered, the owner's own too. A lost answer is unknown and nothing sends it again. */
export async function sendProgramInput(ctx: Ctx, caller: OperatorCaller, input: KeysInput): Promise<Outcome> {
  const typed = typedOf(input);
  const me = await authorizeAccess(ctx, caller);
  const program = await programOf(ctx, me, input.employee);
  const action = randomUUID();
  const reply = await requestProgramInput(ctx, program, { action, snapshot: input.snapshot, ...typed });
  const outcome = outcomeOf(action, reply);
  await record(ctx, { me, caller, program, input, typed, reply, outcome });
  return outcome;
}

type Outcome = { action: string; result: ProgramInputResult['result']; reason: ProgramInputResult['reason'] };
type Typed = { keys: string[]; text: string | null };
type Entry = { me: Agent; caller: OperatorCaller; program: Program; input: KeysInput; typed: Typed; reply: ProgramInputResult | null; outcome: Outcome };

/* Keys by their tmux names and text, one of them at least. */
function typedOf(input: KeysInput): Typed {
  const keys = input.keys ?? [], text = input.text || null;
  if (!keys.length && !text) throw new ApiError(400, 'validation', 'Give keys, text or both.', 'agent_not_ready');
  if (!keys.every(key => ProgramKey.safeParse(key).success)) throw new ApiError(400, 'validation', 'Name each key as tmux does: Enter, Escape, Tab, BSpace, Up, PageDown, F5, a letter or a digit, with C-, M- or S- before it for Ctrl, Alt or Shift, as in C-u.', 'agent_not_ready');
  return { keys, text };
}

const outcomeOf = (action: string, reply: ProgramInputResult | null): Outcome =>
  reply ? { action, result: reply.result, reason: reply.reason } : { action, result: 'unknown', reason: 'action_unknown' };

/* The program operator's look at the case it was given is the picture its report carries. */
async function keepForCase(ctx: Ctx, caller: OperatorCaller, program: Program, png: Buffer): Promise<void> {
  await operatorTransaction(ctx, async tx => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, program.agentId)).for('update');
    const [row] = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, program.agentId), eq(programOperatorCases.companyId, caller.companyId), eq(programOperatorCases.operatorJobId, caller.id), eq(programOperatorCases.status, 'open')));
    if (row) await storeCasePicture(tx, row, png);
  });
}

/* Who, why, which keys and what text with its secrets masked, and what came of it, in the employee's conversation. */
async function record(ctx: Ctx, entry: Entry): Promise<void> {
  const { me } = entry;
  const secrets = await pictureSecrets(ctx, me.companyId);
  const job = await turnOf(ctx, entry);
  const action = { ...actionOf(entry, secrets), case: await caseOf(ctx, entry), targetJobId: job.id };
  const actor = await agentParty(ctx, me.companyId, me.id);
  await logTurnFact(ctx, job, lineOf(entry, action), { notification: await operatorNotification(ctx, job), actor, from: 'agent', by: me.id, name: me.name, operatorAction: action });
}

/* The turn the input went into, as the node said, or else the employee's last one. */
async function turnOf(ctx: Ctx, { program, reply }: Entry): Promise<Job> {
  if (!reply?.jobId) return program.job;
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, reply.jobId), eq(jobs.agentId, program.agentId)));
  return job ?? program.job;
}

/* The case this operator turn was given on the employee: a denial it reports rests on this record. */
async function caseOf(ctx: Ctx, { me, caller, program }: Entry): Promise<string | null> {
  const [held] = await ctx.db.select({ id: programOperatorCases.id }).from(programOperatorCases)
    .where(and(eq(programOperatorCases.agentId, program.agentId), eq(programOperatorCases.companyId, me.companyId), eq(programOperatorCases.operatorJobId, caller.id))).orderBy(desc(programOperatorCases.openedAt)).limit(1);
  return held?.id ?? null;
}

function actionOf({ me, caller, input, typed, reply, outcome }: Entry, secrets: string[]) {
  const question = maskedQuestion(reply?.question ?? null, secrets);
  return {
    id: outcome.action, operatorJobId: caller.id, instance: reply?.instance ?? null, snapshot: input.snapshot, at: new Date().toISOString(),
    actor: { id: me.id, name: me.name }, keys: typed.keys, key: typed.keys.at(-1) ?? null, text: typed.text && masked(typed.text, secrets), reason: input.reason, result: outcome.result, error: outcome.reason,
    question, requestedDecision: input.decision, ...decided(input, question, outcome),
  };
}

/* An answer to a question of permission, given and taken. */
function decided(input: KeysInput, question: OperatorQuestion | null, outcome: Outcome) {
  return input.decision && question?.kind === 'permission' && outcome.result === 'applied' ? { decision: input.decision, permissionDecision: true } : {};
}

function lineOf({ me, input }: Entry, action: ReturnType<typeof actionOf>): string {
  const said = [action.keys.length ? `keys ${action.keys.join(' ')}` : '', action.text ? `text "${action.text}"` : ''].filter(Boolean).join(' and ');
  const choice = 'permissionDecision' in action ? ` Decision: ${input.decision}. Request: ${action.question!.text}.` : '';
  return `${me.name}, ${said}: ${action.result}${action.error ? ` (${action.error})` : ''}. Reason: ${input.reason}.${choice}`;
}

function masked(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter(s => s.length >= SECRET_MIN).sort((a, b) => b.length - a.length)) out = out.replaceAll(secret, HIDDEN);
  return out;
}

function maskedQuestion(question: OperatorQuestion | null, secrets: string[]): OperatorQuestion | null {
  return question ? { ...question, text: masked(question.text, secrets) } : null;
}
