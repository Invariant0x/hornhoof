import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { knowsAgentId, type AgentViewer } from '../../auth/agent-view.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { agents, departments, jobs, people, tasks, vaultEntries, vaultLog } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { deptName } from '../departments/templates.js';
import type { VaultAgent } from './access.js';
import { parseTotp, Totp, totpCode } from './totp.js';

/* The company's vault of site sign-ins: what a person types into the form, how it is kept, what a person sees of it, and
   what an agent that may use it takes. A person's view and the log never hold the password or the code secret; an agent
   gets the password and the current code, never the secret. */

export type Entry = typeof vaultEntries.$inferSelect;

const Scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('company') }),
  z.strictObject({ kind: z.literal('department'), departmentId: z.uuid() }),
  z.strictObject({ kind: z.literal('agent'), agentId: z.uuid() }),
]);
type ScopeInput = z.infer<typeof Scope>;

const Name = z.string().trim().min(1).max(80);
const Site = z.string().trim().min(1).max(2048);
const Login = z.string().trim().min(1).max(320);
const Password = z.string().min(1).max(1024);
/* A code secret as an authenticator shows it, or the otpauth:// address of its QR code; empty for none. */
const Code = z.string().max(2048);

export const NewEntry = z.strictObject({ name: Name, site: Site, login: Login, password: Password, code: Code.optional(), scope: Scope.default({ kind: 'company' }) });
/* An empty password or code keeps the one stored; removeCode drops the code. */
export const EntryChange = z.strictObject({
  name: Name.optional(),
  site: Site.optional(),
  login: Login.optional(),
  password: z.union([z.literal(''), Password]).optional(),
  code: Code.optional(),
  removeCode: z.boolean().optional(),
  scope: Scope.optional(),
});

const invalid = (message: string) => new ApiError(400, 'validation', message, 'vault_invalid');
export const notAllowed = (message: string) => new ApiError(403, 'forbidden', message, 'vault_not_allowed');
export const unknownEntry = () => new ApiError(404, 'not_found', 'There is no such entry in the vault.', 'vault_unknown');

const FIELD_WORDS: Record<string, string> = {
  name: 'a name of 1 to 80 characters',
  site: 'a site or address',
  login: 'a login',
  password: 'a password',
  code: 'a one-time code secret',
  scope: 'who may use the entry',
  removeCode: 'whether to remove the code',
};

/* Which fields were wrong, and never what they held. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '')))].filter(Boolean);
  const words = fields.map(f => FIELD_WORDS[f] ?? f);
  throw invalid(words.length ? `The entry needs ${words.join(', ')}.` : 'The entry is not complete.');
}

const badCode = () => invalid('The one-time code secret is not one an authenticator gives. Copy it again from the site, or leave it empty.');

function parseCode(raw: string): Totp {
  const totp = parseTotp(raw);
  if (!totp) throw badCode();
  return totp;
}

const sealedCode = (ctx: Ctx, raw: string | undefined): string | null => (raw && raw.trim() ? encryptSecret(JSON.stringify(parseCode(raw)), ctx.config.secret) : null);

/* The scope as stored, after checking that its department or agent is of this company. */
async function scopeColumns(ctx: Ctx, companyId: string, scope: ScopeInput) {
  if (scope.kind === 'department') {
    const [dept] = await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, scope.departmentId), eq(departments.companyId, companyId)));
    if (!dept) throw invalid('There is no such department in this company.');
    return { scopeKind: 'department' as const, scopeDepartmentId: dept.id, scopeAgentId: null };
  }
  if (scope.kind === 'agent') {
    const [agent] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, companyId), isNull(agents.removedAt)));
    if (!agent) throw invalid('There is no such agent in this company.');
    return { scopeKind: 'agent' as const, scopeDepartmentId: null, scopeAgentId: agent.id };
  }
  return { scopeKind: 'company' as const, scopeDepartmentId: null, scopeAgentId: null };
}

const nameTaken = () => new ApiError(409, 'conflict', 'The vault already has an entry of this name.', 'vault_name_taken');

async function unique<T>(write: Promise<T>): Promise<T> {
  return write.catch((err: unknown) => {
    const cause = (err as { cause?: { code?: string } }).cause;
    if ((err as { code?: string }).code === '23505' || cause?.code === '23505') throw nameTaken();
    throw err;
  });
}

/* A person at the form, or the orchestrator acting for one: the log keeps the person and the orchestrator both. */
export type Writer = { personId: string; agentId: string | null };

export async function createEntry(ctx: Ctx, companyId: string, writer: Writer, input: z.infer<typeof NewEntry>): Promise<Entry> {
  const scope = await scopeColumns(ctx, companyId, input.scope);
  const values = {
    companyId, name: input.name, site: input.site, login: input.login,
    passwordEnc: encryptSecret(input.password, ctx.config.secret), totpEnc: sealedCode(ctx, input.code),
    ...scope, createdBy: writer.personId, updatedBy: writer.personId,
  };
  return ctx.db.transaction(async tx => {
    const [row] = await unique(tx.insert(vaultEntries).values(values).returning());
    await tx.insert(vaultLog).values({ companyId, entryId: row!.id, entryName: row!.name, site: row!.site, kind: 'created', ...writer });
    return row!;
  });
}

export async function changeEntry(ctx: Ctx, entry: Entry, writer: Writer, input: z.infer<typeof EntryChange>): Promise<Entry> {
  const scope = input.scope ? await scopeColumns(ctx, entry.companyId, input.scope) : {};
  const code = input.removeCode ? { totpEnc: null } : input.code?.trim() ? { totpEnc: sealedCode(ctx, input.code) } : {};
  const set = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.site !== undefined ? { site: input.site } : {}),
    ...(input.login !== undefined ? { login: input.login } : {}),
    ...(input.password ? { passwordEnc: encryptSecret(input.password, ctx.config.secret) } : {}),
    ...code, ...scope, updatedBy: writer.personId, updatedAt: new Date(),
  };
  return ctx.db.transaction(async tx => {
    const [row] = await unique(tx.update(vaultEntries).set(set).where(eq(vaultEntries.id, entry.id)).returning());
    await tx.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: row!.name, site: row!.site, kind: 'changed', ...writer });
    return row!;
  });
}

/* The row goes, and the encrypted values with it; the log keeps its name. */
export async function removeEntry(ctx: Ctx, entry: Entry, writer: Writer): Promise<void> {
  await ctx.db.transaction(async tx => {
    await tx.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'removed', ...writer });
    await tx.delete(vaultEntries).where(eq(vaultEntries.id, entry.id));
  });
}

/* The entry of that id, whichever company it is of: the caller tells another company's from none. */
export async function entryById(ctx: Ctx, id: string): Promise<Entry | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await ctx.db.select().from(vaultEntries).where(eq(vaultEntries.id, id));
  return row ?? null;
}

export async function entryByName(ctx: Ctx, companyId: string, name: string): Promise<Entry | null> {
  const [row] = await ctx.db.select().from(vaultEntries).where(and(eq(vaultEntries.companyId, companyId), eq(sql`lower(${vaultEntries.name})`, name.trim().toLowerCase())));
  return row ?? null;
}

export async function companyEntries(ctx: Ctx, companyId: string): Promise<Entry[]> {
  return ctx.db.select().from(vaultEntries).where(eq(vaultEntries.companyId, companyId)).orderBy(sql`lower(${vaultEntries.name})`);
}

/* What an agent that may use the entry takes to sign in: the login, the password and the code of this moment, logged with
   the task of the agent's turn and no value. */
export async function takeEntry(ctx: Ctx, entry: Entry, agent: VaultAgent) {
  const [job] = agent.jobId ? await ctx.db.select({ taskId: jobs.taskId }).from(jobs).where(eq(jobs.id, agent.jobId)) : [];
  await ctx.db.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'taken', agentId: agent.id, taskId: job?.taskId ?? null });
  const totp = entry.totpEnc ? Totp.parse(JSON.parse(decryptSecret(entry.totpEnc, ctx.config.secret))) : null;
  return {
    name: entry.name,
    site: entry.site,
    login: entry.login,
    password: decryptSecret(entry.passwordEnc, ctx.config.secret),
    ...(totp ? { code: totpCode(totp, Date.now()) } : {}),
  };
}

type Names = { people: Map<string, string>; agents: Map<string, string>; departments: Map<string, string>; tasks: Map<string, number> };

async function namesFor(ctx: Ctx, ids: { people: string[]; agents: string[]; departments: string[]; tasks: string[] }): Promise<Names> {
  const some = <T>(list: string[], read: (list: string[]) => Promise<T[]>) => (list.length ? read([...new Set(list)]) : Promise.resolve([] as T[]));
  const [p, a, d, t] = await Promise.all([
    some(ids.people, list => ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, list))),
    some(ids.agents, list => ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, list))),
    some(ids.departments, list => ctx.db.select({ id: departments.id, name: departments.name, templateKey: departments.templateKey }).from(departments).where(inArray(departments.id, list))),
    some(ids.tasks, list => ctx.db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(inArray(tasks.id, list))),
  ]);
  return {
    people: new Map(p.map(r => [r.id, r.name])),
    agents: new Map(a.map(r => [r.id, r.name])),
    departments: new Map(d.map(r => [r.id, deptName(r)])),
    tasks: new Map(t.map(r => [r.id, r.number])),
  };
}

const who = (map: Map<string, string>, id: string | null) => (id ? { id, name: map.get(id) ?? '' } : null);

/* What anyone sees of an entry: never a value, only whether it has a code. */
export async function entryViews(ctx: Ctx, rows: Entry[]) {
  const names = await namesFor(ctx, {
    people: rows.flatMap(r => [r.createdBy, r.updatedBy]),
    agents: rows.flatMap(r => (r.scopeAgentId ? [r.scopeAgentId] : [])),
    departments: rows.flatMap(r => (r.scopeDepartmentId ? [r.scopeDepartmentId] : [])),
    tasks: [],
  });
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    site: r.site,
    login: r.login,
    hasCode: r.totpEnc !== null,
    scope:
      r.scopeKind === 'department' ? { kind: 'department' as const, departmentId: r.scopeDepartmentId!, departmentName: names.departments.get(r.scopeDepartmentId!) ?? '' }
      : r.scopeKind === 'agent' ? { kind: 'agent' as const, agentId: r.scopeAgentId!, agentName: names.agents.get(r.scopeAgentId!) ?? '' }
      : { kind: 'company' as const },
    createdBy: who(names.people, r.createdBy),
    createdAt: r.createdAt.toISOString(),
    updatedBy: who(names.people, r.updatedBy),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/* The log is the company's work, which every person of it reads, but for the uses of another person's own assistant,
   which nobody else knows of. A task shows by its number only. */
export async function entryLog(ctx: Ctx, entryId: string, viewer: Pick<AgentViewer, 'apart'>, limit = 200) {
  const rows = (await ctx.db.select().from(vaultLog).where(eq(vaultLog.entryId, entryId)).orderBy(desc(vaultLog.at)).limit(limit)).filter(r => r.agentId === null || knowsAgentId(viewer, r.agentId));
  const names = await namesFor(ctx, {
    people: rows.flatMap(r => (r.personId ? [r.personId] : [])),
    agents: rows.flatMap(r => (r.agentId ? [r.agentId] : [])),
    departments: [],
    tasks: rows.flatMap(r => (r.taskId ? [r.taskId] : [])),
  });
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    person: who(names.people, r.personId),
    agent: who(names.agents, r.agentId),
    task: r.taskId ? { id: r.taskId, number: names.tasks.get(r.taskId) ?? null } : null,
    at: r.at.toISOString(),
  }));
}
