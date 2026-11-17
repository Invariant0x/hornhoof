import { randomUUID } from 'node:crypto';
import type { PhoneReadinessIssue } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { companyPhones } from '../../db/schema.js';
import { nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { phoneBinding } from './queue.js';
import { phoneBaselineCapable, phoneCapable, phoneRequest } from './rpc.js';
import type { CompanyPhone } from './store.js';

const CHECK_EVERY_MS = 15_000;
type Check = { nodeId: string; serial: string; hardwareKey: string; issues: PhoneReadinessIssue[] | null; pending?: Promise<void> };
const checks = new WeakMap<Ctx, Map<string, Check>>();
const sameBinding = (check: Check | undefined, phone: CompanyPhone): check is Check =>
  check?.nodeId === phone.nodeId && check.serial === phone.serial && check.hardwareKey === phone.hardwareKey;

/* A live reading, which is obtained again when the server or the node comes back. */
export function phoneReadiness(ctx: Ctx, phone: CompanyPhone): PhoneReadinessIssue[] | null {
  const node = nodeIdentity(phone.nodeId);
  if (!phoneCapable(ctx, node)) return ['connection'];
  if (!phoneBaselineCapable(ctx, node)) return ['nodeUpdate'];
  const check = checks.get(ctx)?.get(phone.id);
  return sameBinding(check, phone) ? check.issues : null;
}

export async function refreshPhoneReadiness(ctx: Ctx, phone: CompanyPhone): Promise<void> {
  const node = nodeIdentity(phone.nodeId);
  if (!phoneBaselineCapable(ctx, node)) return;
  const found = checks.get(ctx) ?? new Map<string, Check>();
  checks.set(ctx, found);
  const old = found.get(phone.id);
  if (sameBinding(old, phone) && old.pending) return old.pending;
  const check: Check = { nodeId: phone.nodeId, serial: phone.serial, hardwareKey: phone.hardwareKey, issues: sameBinding(old, phone) ? old.issues : null };
  found.set(phone.id, check);
  const request = phoneRequest(ctx, node, { type: 'phone.baseline', requestId: randomUUID(), binding: phoneBinding(phone) });
  check.pending = request.then(result => {
    check.issues = result.status === 'needs_person' ? ['connection'] : (result.status === 'ok' ? result.readiness : undefined) ?? ['check'];
  }).finally(() => { delete check.pending; });
  return check.pending;
}

/* A hello checks existing phones at once. The regular check also sees a phone reconnect to a node that stayed online. */
export function checkConnectedPhones(ctx: Ctx, node?: NodeIdentity): void {
  if (node && (node.kind !== 'node' || !phoneBaselineCapable(ctx, node))) return;
  void (async () => {
    const phones = await ctx.db.select().from(companyPhones).where(and(isNull(companyPhones.removedAt), node ? eq(companyPhones.nodeId, node.nodeId) : undefined));
    await Promise.all(phones.map(phone => refreshPhoneReadiness(ctx, phone)));
  })().catch(() => ctx.log.warn('Could not check company phone settings.'));
}

export function startPhoneReadiness(app: FastifyInstance, ctx: Ctx): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  ctx.mode.whenLead(() => { timer = setInterval(() => checkConnectedPhones(ctx), CHECK_EVERY_MS).unref(); }, stop);
  app.addHook('onClose', async () => stop());
}
