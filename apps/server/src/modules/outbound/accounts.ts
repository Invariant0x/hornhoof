import type { GateCode } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Checker } from '../../checker.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agents, outboundAccounts, outboundAttempts, outboundBindings, outboundChannels, type OutboundSetupKind } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Tx } from '../tasks/engine.js';
import { digestOf } from './checks.js';
import { settleAttempt } from './core.js';
import { isOneAddress } from './delivery.js';
import { channelIn, type Channel } from './policies.js';
import { requireRunner } from './runner.js';
import { logSetup } from './setup-log.js';
import { endpointOf } from './webhook.js';

/* The accounts messages leave from. A person gives an account's settings once, over a protected route, and nothing reads them
   again but the dispatcher: not a view, not a job, not a log, not a model. Whoever writes from an account is one author, for
   as long as a person says, and nothing changes hands while an attempt of it has no known end. */

type Account = typeof outboundAccounts.$inferSelect;
type Binding = typeof outboundBindings.$inferSelect;
type Attempt = typeof outboundAttempts.$inferSelect;

const Key = z.string().min(32).max(1024);
const Ca = z.string().min(1).max(20_000);
const SmtpConfig = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(['tls', 'starttls']),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  from: z.string().refine(isOneAddress),
  eventKey: Key.optional(),
  ca: Ca.optional(),
});
const WebhookConfig = z.strictObject({
  endpoint: z.string().max(2048).refine(raw => endpointOf(raw) !== null),
  signingKey: Key,
  readback: z.boolean().optional(),
  ca: Ca.optional(),
});
export type SmtpSettings = z.infer<typeof SmtpConfig>;
export type WebhookSettings = z.infer<typeof WebhookConfig>;
export type AccountSettings = { adapter: 'smtp'; config: SmtpSettings } | { adapter: 'webhook'; config: WebhookSettings };

const IdParams = z.strictObject({ id: z.uuid() });
/* config: the settings a person gives. sameAs: an account whose settings the new one takes, with from as its own address,
   which the orchestrator and a head use too, as no setting passes through them. */
const SetupBody = z
  .strictObject({ channelId: z.uuid(), label: z.string().trim().min(1).max(200), config: z.unknown().optional(), sameAs: z.uuid().optional(), from: z.string().optional() })
  .refine(body => (body.config === undefined) !== (body.sameAs === undefined) && (body.from === undefined || body.sameAs !== undefined), { message: 'Give either config, or sameAs with an optional from.' });
const RotateBody = z.strictObject({ config: z.unknown() });
const BindBody = z.strictObject({ agentId: z.uuid() });
const SettleBody = z.strictObject({ outcome: z.enum(['accepted', 'definitely_not_accepted']), evidence: z.string().trim().min(1).max(2000) });

const unknownAccount = () => new ApiError(404, 'not_found', 'There is no such account here.', 'outbound_unknown');
const conflict = (message: string, reasonCodes: GateCode[] = []) => new ApiError(409, 'conflict', message, 'outbound_conflict', { reasonCodes });
const notYours = (message: string) => new ApiError(403, 'forbidden', message, 'outbound_not_allowed');

/* Which fields were wrong, and none of what they said. */
function checked<T>(schema: Checker<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, 'validation', 'These settings cannot be used.', 'outbound_invalid', { fields: parsed.error.issues.map(issue => issue.path.join('.')) });
}

const settingsOf = (adapter: Channel['adapter'], raw: unknown): AccountSettings =>
  adapter === 'smtp' ? { adapter, config: checked(SmtpConfig, raw) } : { adapter, config: checked(WebhookConfig, raw) };

/* What its counts go by follows from where it really sends from, so nothing said about it can spread it over more domains. */
const senderDomainOf = (settings: AccountSettings): string =>
  settings.adapter === 'smtp' ? settings.config.from.slice(settings.config.from.lastIndexOf('@') + 1).toLowerCase() : endpointOf(settings.config.endpoint)!.hostname.toLowerCase();

const viewOf = (account: Account, binding: Binding | undefined) => ({
  accountId: account.id, channelId: account.channelId, label: account.label, senderDomain: account.senderDomain, status: account.status, configGeneration: account.configGeneration,
  binding: binding ? { agentId: binding.agentId, generation: binding.generation } : null,
});

export async function setupAccount(ctx: Ctx, channel: Channel, input: { label: string; config: unknown; createdBy: string }) {
  const settings = settingsOf(channel.adapter, input.config);
  const values = {
    companyId: channel.companyId, departmentId: channel.departmentId, productId: channel.productId, channelId: channel.id, senderDomain: senderDomainOf(settings), label: input.label,
    configEnc: encryptSecret(JSON.stringify(settings.config), ctx.config.secret), createdBy: input.createdBy,
  };
  const made = await ctx.db.insert(outboundAccounts).values(values).returning().catch((err: unknown) => {
    throw isUniqueViolation(err) ? conflict('This channel already has an account of this name.') : err;
  });
  return viewOf(made[0]!, undefined);
}

const accountIn = async (ctx: Ctx, companyId: string, id: string): Promise<Account> => {
  const [account] = await ctx.db.select().from(outboundAccounts).where(and(eq(outboundAccounts.id, id), eq(outboundAccounts.companyId, companyId)));
  if (!account) throw unknownAccount();
  return account;
};

type Held = { channel: Channel; account: Account; binding: Binding | undefined };

/* The channel, the account and who writes from it, in the order the kernel takes them. */
async function holdAccount(tx: Tx, seen: Account): Promise<Held> {
  const [channel] = await tx.select().from(outboundChannels).where(eq(outboundChannels.id, seen.channelId)).for('update');
  const [account] = await tx.select().from(outboundAccounts).where(eq(outboundAccounts.id, seen.id)).for('update');
  const [binding] = await tx.select().from(outboundBindings).where(and(eq(outboundBindings.accountId, seen.id), eq(outboundBindings.status, 'active'))).for('update');
  return { channel: channel!, account: account!, binding };
}

/* Each change is a new generation, so what was reserved under the old settings cannot go. What is on its way goes on: only its
   own end settles it. */
export async function rotateAccount(ctx: Ctx, seen: Account, raw: unknown, now = new Date()) {
  return ctx.db.transaction(async tx => {
    const { channel, account, binding } = await holdAccount(tx, seen);
    if (account.status === 'revoked') throw conflict('This account was revoked. Set up a new one.');
    const settings = settingsOf(channel.adapter, raw);
    if (senderDomainOf(settings) !== account.senderDomain) throw new ApiError(400, 'validation', 'An account keeps its sender domain: its counts go by it. Set up a new account for another one.', 'outbound_invalid');
    const [row] = await tx.update(outboundAccounts).set({ configEnc: encryptSecret(JSON.stringify(settings.config), ctx.config.secret), configGeneration: account.configGeneration + 1, status: 'active', updatedAt: now }).where(eq(outboundAccounts.id, account.id)).returning();
    return viewOf(row!, binding);
  });
}

/* For good, and its settings are gone with it. */
export async function revokeAccount(ctx: Ctx, seen: Account, now = new Date()) {
  return ctx.db.transaction(async tx => {
    const { account, binding } = await holdAccount(tx, seen);
    const [row] = await tx.update(outboundAccounts).set({ configEnc: encryptSecret('{}', ctx.config.secret), configGeneration: account.configGeneration + 1, status: 'revoked', updatedAt: now }).where(eq(outboundAccounts.id, account.id)).returning();
    return viewOf(row!, binding);
  });
}

async function refuseWhileOnItsWay(tx: Tx, accountId: string): Promise<void> {
  const open = await tx.select({ id: outboundAttempts.id }).from(outboundAttempts).where(and(eq(outboundAttempts.accountId, accountId), inArray(outboundAttempts.status, ['reserved', 'sending', 'unknown']))).limit(1);
  if (open.length) throw conflict('An attempt of this account has no known end yet. Settle it first.', ['delivery_unknown']);
}

async function requireFreeAuthor(tx: Tx, account: Account, agentId: string): Promise<void> {
  const [author] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, account.companyId), eq(agents.departmentId, account.departmentId), isNull(agents.removedAt)));
  if (!author) throw new ApiError(404, 'not_found', 'There is no such author in this account\'s department.', 'outbound_unknown');
  const [other] = await tx.select({ id: outboundBindings.id }).from(outboundBindings).where(and(eq(outboundBindings.agentId, agentId), eq(outboundBindings.status, 'active')));
  if (other) throw conflict('This author already writes from another account.', ['account_bound_elsewhere']);
}

const endBinding = (tx: Tx, binding: Binding, now: Date) => tx.update(outboundBindings).set({ status: 'released', releasedAt: now }).where(eq(outboundBindings.id, binding.id));

/* The account's author from now on. What the last one queued stays theirs, and its next look ends it. */
export async function bindAccount(ctx: Ctx, seen: Account, input: { agentId: string; createdBy: string }, now = new Date()) {
  const bound = ctx.db.transaction(async tx => {
    const { account, binding } = await holdAccount(tx, seen);
    if (binding?.agentId === input.agentId) return viewOf(account, binding);
    await refuseWhileOnItsWay(tx, account.id);
    await requireFreeAuthor(tx, account, input.agentId);
    if (binding) await endBinding(tx, binding, now);
    const [top] = await tx.select({ generation: max(outboundBindings.generation) }).from(outboundBindings).where(eq(outboundBindings.accountId, account.id));
    const [next] = await tx.insert(outboundBindings).values({ companyId: account.companyId, accountId: account.id, agentId: input.agentId, generation: (top?.generation ?? 0) + 1, createdBy: input.createdBy }).returning();
    return viewOf(account, next);
  });
  return bound.catch((err: unknown) => {
    throw isUniqueViolation(err) ? conflict('This author already writes from another account.', ['account_bound_elsewhere']) : err;
  });
}

/* Only ever a person's doing: no timer, lease or round comes here. */
export async function releaseAccount(ctx: Ctx, seen: Account, now = new Date()) {
  return ctx.db.transaction(async tx => {
    const { account, binding } = await holdAccount(tx, seen);
    await refuseWhileOnItsWay(tx, account.id);
    if (binding) await endBinding(tx, binding, now);
    return viewOf(account, undefined);
  });
}

/* A person's word on an attempt that nothing else can settle. What they know it by stays with them, as a digest. */
export async function settleByPerson(ctx: Ctx, attempt: Attempt, input: z.infer<typeof SettleBody>) {
  if (attempt.status !== 'unknown') throw conflict('Only an attempt whose end is unknown can be settled by hand.');
  if (input.outcome === 'accepted') await settleAttempt(ctx, attempt.id, { kind: 'accepted', providerReceipt: `person:${digestOf(input.evidence)}`, acceptedAt: new Date().toISOString() });
  else await settleAttempt(ctx, attempt.id, { kind: 'definitely_not_accepted', safeCode: 'person_confirmed' });
  return { attemptId: attempt.id, status: input.outcome };
}

/* What the dispatcher sends with, and the only way to it: null when they are gone or no longer what the attempt was admitted under. */
export async function settingsToSend(ctx: Ctx, accountId: string, configGeneration: number): Promise<AccountSettings | null> {
  const [row] = await ctx.db.select({ configEnc: outboundAccounts.configEnc, generation: outboundAccounts.configGeneration, status: outboundAccounts.status, adapter: outboundChannels.adapter }).from(outboundAccounts).innerJoin(outboundChannels, eq(outboundChannels.id, outboundAccounts.channelId)).where(eq(outboundAccounts.id, accountId));
  if (!row || row.status !== 'active' || row.generation !== configGeneration) return null;
  return settingsFrom(ctx, row);
}

/* What reconciling asks with: the settings an account has now, whichever generation an attempt began under. */
export async function currentSettings(ctx: Ctx, accountId: string): Promise<AccountSettings | null> {
  const [row] = await ctx.db.select({ configEnc: outboundAccounts.configEnc, adapter: outboundChannels.adapter, status: outboundAccounts.status }).from(outboundAccounts).innerJoin(outboundChannels, eq(outboundChannels.id, outboundAccounts.channelId)).where(eq(outboundAccounts.id, accountId));
  return row && row.status !== 'revoked' ? settingsFrom(ctx, row) : null;
}

/* Settings that no longer read as settings send nothing. */
function settingsFrom(ctx: Ctx, row: { configEnc: string; adapter: Channel['adapter'] }): AccountSettings | null {
  try {
    return settingsOf(row.adapter, JSON.parse(decryptSecret(row.configEnc, ctx.config.secret)));
  } catch {
    return null;
  }
}

/* A sign-in the provider refused stops the account until a person gives new settings, so it is not tried over and over. */
export const markInvalid = (ctx: Ctx, accountId: string, configGeneration: number, now = new Date()) =>
  ctx.db.update(outboundAccounts).set({ status: 'invalid', updatedAt: now }).where(and(eq(outboundAccounts.id, accountId), eq(outboundAccounts.configGeneration, configGeneration), eq(outboundAccounts.status, 'active')));

/* A setting and its secret never pass through a model, a head's included: only a person gives them, on their own screen. A
   model connects an account only with the settings of one the company has, by sameAs. */
function refuseModel(me: Person): void {
  if (me.via) throw notYours('Only a person does this: settings never pass through a model. Connect it with sameAs, the settings of an account the company has, or ask a person to give new ones on the channel\'s screen.');
}

/* The settings of an account the caller runs, for a new account of a channel with the same adapter, sending from its own
   address when one is given: they go from one account to the other inside Hornhoof, never through the caller. */
async function settingsLike(ctx: Ctx, me: Person, channel: Channel, sameAs: string, from: string | undefined): Promise<unknown> {
  const source = await runnableAccount(ctx, me, sameAs);
  const settings = await currentSettings(ctx, source.id);
  if (!settings) throw conflict('That account has no settings that can be used.');
  if (settings.adapter !== channel.adapter) throw new ApiError(400, 'validation', `That account is ${settings.adapter}, and this channel is ${channel.adapter}.`, 'outbound_invalid', { fields: ['sameAs'] });
  if (from === undefined) return settings.config;
  if (settings.adapter !== 'smtp') throw new ApiError(400, 'validation', 'Only a mail account sends from an address.', 'outbound_invalid', { fields: ['from'] });
  return { ...settings.config, from };
}

const idOf = (req: FastifyRequest): string => IdParams.parse(req.params).id;
const unknownChannel = () => new ApiError(404, 'not_found', 'There is no such channel.', 'outbound_unknown');

async function runnableAccount(ctx: Ctx, me: Person, id: string): Promise<Account> {
  const account = await accountIn(ctx, me.companyId, id);
  await requireRunner(ctx.db, me, account.departmentId, unknownAccount);
  return account;
}

async function runnableChannel(ctx: Ctx, me: Person, id: string): Promise<Channel> {
  const channel = await channelIn(ctx.db, me.companyId, id);
  await requireRunner(ctx.db, me, channel.departmentId, unknownChannel);
  return channel;
}

/* What the department's log keeps of a change of an account: its name and generation, never a setting. */
const logAccount = (ctx: Ctx, me: Person, account: Pick<Account, 'companyId' | 'departmentId' | 'channelId'>, kind: OutboundSetupKind, view: ReturnType<typeof viewOf>) =>
  logSetup(ctx.db, me, { companyId: account.companyId, departmentId: account.departmentId, channelId: account.channelId, kind, subjectId: view.accountId, detail: { label: view.label, configGeneration: view.configGeneration, agentId: view.binding?.agentId ?? null } });

const logged = (req: FastifyRequest, me: Person, accountId: string, did: string) => req.log.info({ accountId, did, personId: me.id }, 'outbound account changed');

async function accountsOfChannel(ctx: Ctx, channelId: string) {
  const rows = await ctx.db.select({ account: outboundAccounts, binding: outboundBindings }).from(outboundAccounts).leftJoin(outboundBindings, and(eq(outboundBindings.accountId, outboundAccounts.id), eq(outboundBindings.status, 'active'))).where(eq(outboundAccounts.channelId, channelId)).orderBy(outboundAccounts.label);
  return { accounts: rows.map(row => viewOf(row.account, row.binding ?? undefined)) };
}

function settleRoute(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/outbound/attempts/:id/settle', async req => {
    const me = await requirePerson(req, ctx.db);
    refuseModel(me);
    const [attempt] = await ctx.db.select().from(outboundAttempts).where(and(eq(outboundAttempts.id, idOf(req)), eq(outboundAttempts.companyId, me.companyId)));
    if (!attempt) throw new ApiError(404, 'not_found', 'There is no such attempt here.', 'outbound_unknown');
    await runnableAccount(ctx, me, attempt.accountId);
    const settled = await settleByPerson(ctx, attempt, SettleBody.parse(req.body));
    logged(req, me, attempt.accountId, 'settled');
    return settled;
  });
}

export function accountRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.post('/api/outbound/accounts', async req => {
    const me = await requirePerson(req, db);
    const body = SetupBody.parse(req.body);
    if (body.sameAs === undefined) refuseModel(me);
    const channel = await runnableChannel(ctx, me, body.channelId);
    const config = body.sameAs === undefined ? body.config : await settingsLike(ctx, me, channel, body.sameAs, body.from);
    const made = await setupAccount(ctx, channel, { label: body.label, config, createdBy: me.id });
    await logAccount(ctx, me, { ...channel, channelId: channel.id }, 'account_set_up', made);
    logged(req, me, made.accountId, 'set up');
    return made;
  });

  app.get('/api/outbound/channels/:id/accounts', async req => {
    const me = await requirePerson(req, db);
    return accountsOfChannel(ctx, (await runnableChannel(ctx, me, idOf(req))).id);
  });

  app.post('/api/outbound/accounts/:id/rotate', async req => {
    const me = await requirePerson(req, db);
    refuseModel(me);
    const account = await runnableAccount(ctx, me, idOf(req));
    const rotated = await rotateAccount(ctx, account, RotateBody.parse(req.body).config);
    await logAccount(ctx, me, account, 'account_rotated', rotated);
    logged(req, me, account.id, 'rotated');
    return rotated;
  });

  app.post('/api/outbound/accounts/:id/revoke', async req => {
    const me = await requirePerson(req, db);
    const account = await runnableAccount(ctx, me, idOf(req));
    const revoked = await revokeAccount(ctx, account);
    await logAccount(ctx, me, account, 'account_revoked', revoked);
    logged(req, me, account.id, 'revoked');
    return revoked;
  });

  app.post('/api/outbound/accounts/:id/bind', async req => {
    const me = await requirePerson(req, db);
    const account = await runnableAccount(ctx, me, idOf(req));
    const bound = await bindAccount(ctx, account, { agentId: BindBody.parse(req.body).agentId, createdBy: me.id });
    await logAccount(ctx, me, account, 'account_bound', bound);
    logged(req, me, account.id, 'bound');
    return bound;
  });

  app.post('/api/outbound/accounts/:id/release', async req => {
    const me = await requirePerson(req, db);
    const account = await runnableAccount(ctx, me, idOf(req));
    const released = await releaseAccount(ctx, account);
    await logAccount(ctx, me, account, 'account_released', released);
    logged(req, me, account.id, 'released');
    return released;
  });

  settleRoute(app, ctx);
}
