import { randomUUID } from 'node:crypto';
import type { PhoneReadinessIssue } from '@hornhoof/protocol';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { companyPhones, phoneSessions } from '../../db/schema.js';
import { nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { holding, phoneBinding } from './queue.js';
import { phoneBaselineCapable, phoneCapable, phoneRequest } from './rpc.js';
import type { CompanyPhone } from './store.js';

const CHECK_EVERY_MS = 5 * 60_000;
type Check = { nodeId: string; serial: string; hardwareKey: string; issues: PhoneReadinessIssue[] | null; at: number; pending?: Promise<void> };
const checks = new WeakMap<Ctx, Map<string, Check>>();
const sameBinding = <T extends Pick<CompanyPhone, 'nodeId' | 'serial' | 'hardwareKey'>>(check: T | undefined, phone: CompanyPhone): check is T =>
  check?.nodeId === phone.nodeId && check.serial === phone.serial && check.hardwareKey === phone.hardwareKey;

/* A live reading, which is obtained again when the server or the node comes back. */
export function phoneReadiness(ctx: Ctx, phone: CompanyPhone): PhoneReadinessIssue[] | null {
  const node = nodeIdentity(phone.nodeId);
  if (!phoneCapable(ctx, node)) return ['connection'];
  if (!phoneBaselineCapable(ctx, node)) return ['nodeUpdate'];
  const check = checks.get(ctx)?.get(phone.id);
  return sameBinding(check, phone) ? check.issues : null;
}

export const pendingPhoneReadiness = (ctx: Ctx, phoneId: string) => checks.get(ctx)?.get(phoneId)?.pending;

function startCheck(ctx: Ctx, phone: CompanyPhone, node: NodeIdentity): Check {
  const found = checks.get(ctx) ?? new Map<string, Check>();
  checks.set(ctx, found);
  const old = found.get(phone.id);
  const check: Check = { nodeId: phone.nodeId, serial: phone.serial, hardwareKey: phone.hardwareKey, issues: sameBinding(old, phone) ? old.issues : null, at: ctx.clock() };
  found.set(phone.id, check);
  check.pending = phoneRequest(ctx, node, { type: 'phone.baseline', requestId: randomUUID(), binding: phoneBinding(phone) }).then(result => {
    if (result.status === 'busy') return;
    check.issues = result.status === 'needs_person' ? ['connection'] : (result.status === 'ok' ? result.readiness : undefined) ?? ['check'];
  }).finally(() => { delete check.pending; });
  return check;
}

export async function refreshPhoneReadiness(ctx: Ctx, phone: CompanyPhone, periodic = false): Promise<void> {
  const node = nodeIdentity(phone.nodeId);
  if (!phoneBaselineCapable(ctx, node)) return;
  const old = checks.get(ctx)?.get(phone.id);
  if (periodic && sameBinding(old, phone) && old.at + CHECK_EVERY_MS > ctx.clock()) return;
  /* The same row lock as the borrow queue. The queue waits for a check already sent before opening a session. */
  const pending = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(companyPhones).where(eq(companyPhones.id, phone.id)).for('update');
    if (!current || current.removedAt || !sameBinding(current, phone)) return;
    const [held] = await tx.select({ id: phoneSessions.id }).from(phoneSessions)
      .where(and(eq(phoneSessions.phoneId, current.id), inArray(phoneSessions.status, [...holding]))).limit(1);
    if (held) return;
    const check = checks.get(ctx)?.get(current.id);
    if (check?.pending) return { done: check.pending };
    if (periodic && sameBinding(check, current) && check.at + CHECK_EVERY_MS > ctx.clock()) return;
    return { done: startCheck(ctx, current, node).pending };
  });
  await pending?.done;
}

/* A hello checks idle phones at once. The slower sweep also catches a phone that comes back while its node stays online. */
export async function checkConnectedPhones(ctx: Ctx, node?: NodeIdentity): Promise<void> {
  if (node && (node.kind !== 'node' || !phoneBaselineCapable(ctx, node))) return;
  try {
    const phones = await ctx.db.select().from(companyPhones).where(and(isNull(companyPhones.removedAt), node ? eq(companyPhones.nodeId, node.nodeId) : undefined));
    await Promise.all(phones.map(phone => refreshPhoneReadiness(ctx, phone, !node)));
  } catch { ctx.log.warn('Could not check company phone settings.'); }
}

export function startPhoneReadiness(app: FastifyInstance, ctx: Ctx): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  ctx.mode.whenLead(() => { timer = setInterval(() => void checkConnectedPhones(ctx), CHECK_EVERY_MS).unref(); }, stop);
  app.addHook('onClose', async () => stop());
}
