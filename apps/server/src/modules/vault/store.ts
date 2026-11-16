import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { knowsAgentId, type AgentViewer } from '../../auth/agent-view.js';
import type { actorOf } from '../../auth/session.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { agents, people, tasks, vaultEntries, vaultLog } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { parseTotp, Totp } from './totp.js';

/* The company's vault of site sign-ins: what a person or an agent saves, how it is kept, and what people see of it. The
   password and the code secret go in through here and come out only to an agent that takes the entry to sign in. */

export type Entry = typeof vaultEntries.$inferSelect;
/* Who saves an entry: a person, or an agent, such as the orchestrator acting for one. */
type Actor = ReturnType<typeof actorOf>;

const Name = z.string().trim().min(1).max(80);
const Site = z.string().trim().min(1).max(2048);
const Login = z.string().trim().min(1).max(320);
const Password = z.string().min(1).max(1024);
/* A code secret as an authenticator shows it, or the otpauth:// address of its QR code; empty for none. */
const Code = z.string().max(2048);

export const NewEntry = z.strictObject({ name: Name, site: Site, login: Login, password: Password, code: Code.optional() });
/* An empty password or code keeps the one stored; removeCode drops the code. */
export const EntryChange = z.strictObject({
  name: Name.optional(),
  site: Site.optional(),
  login: Login.optional(),
  password: z.union([z.literal(''), Password]).optional(),
  code: Code.optional(),
  removeCode: z.boolean().optional(),
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

function sealedCode(ctx: Ctx, raw: string): string {
  const totp = parseTotp(raw);
  if (!totp) throw invalid('The one-time code secret is not one an authenticator gives. Copy it again from the site, or leave it empty.');
  return encryptSecret(JSON.stringify(totp), ctx.config.secret);
}

const nameTaken = () => new ApiError(409, 'conflict', 'The vault already has an entry of this name.', 'vault_name_taken');

async function unique<T>(write: Promise<T>): Promise<T> {
  return write.catch((err: unknown) => {
    const cause = (err as { cause?: { code?: string } }).cause;
    if ((err as { code?: string }).code === '23505' || cause?.code === '23505') throw nameTaken();
    throw err;
  });
}

export async function createEntry(ctx: Ctx, companyId: string, actor: Actor, input: z.infer<typeof NewEntry>): Promise<Entry> {
  const values = {
    companyId, name: input.name, site: input.site, login: input.login,
    passwordEnc: encryptSecret(input.password, ctx.config.secret), totpEnc: input.code?.trim() ? sealedCode(ctx, input.code) : null,
    ...('personId' in actor ? { createdBy: actor.personId } : { createdByAgent: actor.agentId }),
  };
  return ctx.db.transaction(async tx => {
    const [row] = await unique(tx.insert(vaultEntries).values(values).returning());
    await tx.insert(vaultLog).values({ companyId, entryId: row!.id, entryName: row!.name, site: row!.site, kind: 'created', ...actor });
    return row!;
  });
}

export async function changeEntry(ctx: Ctx, entry: Entry, actor: Actor, input: z.infer<typeof EntryChange>): Promise<Entry> {
  const set = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.site !== undefined ? { site: input.site } : {}),
    ...(input.login !== undefined ? { login: input.login } : {}),
    ...(input.password ? { passwordEnc: encryptSecret(input.password, ctx.config.secret) } : {}),
    ...(input.removeCode ? { totpEnc: null } : input.code?.trim() ? { totpEnc: sealedCode(ctx, input.code) } : {}),
  };
  return ctx.db.transaction(async tx => {
    const [row] = Object.keys(set).length ? await unique(tx.update(vaultEntries).set(set).where(eq(vaultEntries.id, entry.id)).returning()) : [entry];
    await tx.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: row!.name, site: row!.site, kind: 'changed', ...actor });
    return row!;
  });
}

/* The row goes, and the encrypted values with it; the log keeps its name. */
export async function removeEntry(ctx: Ctx, entry: Entry, actor: Actor): Promise<void> {
  await ctx.db.transaction(async tx => {
    await tx.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'removed', ...actor });
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

/* What an agent types to sign in: the stored password and the code secret, opened. */
export function secretsOf(ctx: Ctx, entry: Entry): { password: string; totp: Totp | null } {
  return {
    password: decryptSecret(entry.passwordEnc, ctx.config.secret),
    totp: entry.totpEnc ? Totp.parse(JSON.parse(decryptSecret(entry.totpEnc, ctx.config.secret))) : null,
  };
}

type Names = { people: Map<string, string>; agents: Map<string, string>; tasks: Map<string, number> };

async function namesFor(ctx: Ctx, ids: { people: string[]; agents: string[]; tasks: string[] }): Promise<Names> {
  const some = <T>(list: string[], read: (list: string[]) => Promise<T[]>) => (list.length ? read([...new Set(list)]) : Promise.resolve([] as T[]));
  const [p, a, t] = await Promise.all([
    some(ids.people, list => ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, list))),
    some(ids.agents, list => ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, list))),
    some(ids.tasks, list => ctx.db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(inArray(tasks.id, list))),
  ]);
  return { people: new Map(p.map(r => [r.id, r.name])), agents: new Map(a.map(r => [r.id, r.name])), tasks: new Map(t.map(r => [r.id, r.number])) };
}

const named = (map: Map<string, string>, id: string | null) => (id ? { id, name: map.get(id) ?? '' } : null);

/* The work of the company, which every person of it reads, but for what another person's own assistant did, which nobody
   else knows of. */
type Viewer = Pick<AgentViewer, 'apart'> | null;
const knownAgent = (viewer: Viewer, id: string | null) => (id !== null && (viewer === null || knowsAgentId(viewer, id)) ? id : null);

/* What anyone sees of an entry: never a value, only whether it has a code. The viewer is null for an agent, which sees the
   company as it is. */
export async function entryViews(ctx: Ctx, rows: Entry[], viewer: Viewer) {
  const names = await namesFor(ctx, { people: rows.flatMap(r => (r.createdBy ? [r.createdBy] : [])), agents: rows.flatMap(r => (r.createdByAgent ? [r.createdByAgent] : [])), tasks: [] });
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    site: r.site,
    login: r.login,
    hasCode: r.totpEnc !== null,
    createdBy: named(names.people, r.createdBy) ?? named(names.agents, knownAgent(viewer, r.createdByAgent)),
    createdAt: r.createdAt.toISOString(),
  }));
}

/* The log of an entry. A task shows by its number only. */
export async function entryLog(ctx: Ctx, entryId: string, viewer: Pick<AgentViewer, 'apart'>, limit = 200) {
  const rows = (await ctx.db.select().from(vaultLog).where(eq(vaultLog.entryId, entryId)).orderBy(desc(vaultLog.at)).limit(limit)).filter(r => r.agentId === null || knownAgent(viewer, r.agentId));
  const names = await namesFor(ctx, {
    people: rows.flatMap(r => (r.personId ? [r.personId] : [])),
    agents: rows.flatMap(r => (r.agentId ? [r.agentId] : [])),
    tasks: rows.flatMap(r => (r.taskId ? [r.taskId] : [])),
  });
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    person: named(names.people, r.personId),
    agent: named(names.agents, r.agentId),
    task: r.taskId ? { id: r.taskId, number: names.tasks.get(r.taskId) ?? null } : null,
    at: r.at.toISOString(),
  }));
}
