import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Checker } from '../../checker.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { signedBody, signedToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { outboundChannels, outboundContactEvents, outboundContacts, outboundPermissions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Tx } from '../tasks/engine.js';
import { digestOf } from './checks.js';
import { cancelQueuedTo } from './policies.js';

/* Whom a company may write to and what they said about it. One row for one address, sealed. A refusal is for good: nothing
   imported later brings a contact back, and a queued message to them is cancelled in the step that records it. */

type ContactKind = (typeof outboundContacts.$inferSelect)['kind'];
type Contact = typeof outboundContacts.$inferSelect;
type EventKind = (typeof outboundContactEvents.$inferSelect)['kind'];

const spelled = (address: string): string => address.trim().toLowerCase();

/* What an address and a public destination are compared by, however they were written. */
export const recipientDigest = (recipient: string): string => digestOf(spelled(recipient));

const EMAIL = z.email().max(320);
const HANDLE = z.string().regex(/^\S{1,320}$/);
const ADDRESS: Record<ContactKind, Checker<string>> = { email: EMAIL, direct: HANDLE };

function readAddress(kind: ContactKind, address: string): string {
  const parsed = ADDRESS[kind].safeParse(spelled(address));
  if (!parsed.success) throw new ApiError(400, 'validation', 'This is not one address.', 'outbound_invalid');
  return parsed.data;
}

const notFound = () => new ApiError(404, 'not_found', 'There is no such contact.', 'outbound_unknown');

async function theContact(tx: Tx, companyId: string, contactId: string): Promise<Contact> {
  const [contact] = await tx.select().from(outboundContacts).where(and(eq(outboundContacts.id, contactId), eq(outboundContacts.companyId, companyId))).for('update');
  if (!contact) throw notFound();
  return contact;
}

type Said = { contact: Contact; kind: EventKind; dedupKey: string; evidenceDigest: string; now: Date };
const record = (tx: Tx, s: Said) =>
  tx.insert(outboundContactEvents).values({ companyId: s.contact.companyId, contactId: s.contact.id, kind: s.kind, dedupKey: s.dedupKey, evidenceDigest: s.evidenceDigest, occurredAt: s.now }).onConflictDoNothing();

export type NewContact = { companyId: string; kind: ContactKind; address: string; channel: { id: string; purpose: string }; source: string; evidence: string };

/* A contact and their permission for a channel's purpose. Someone who said no stays no, whatever a list says. */
export async function addContact(ctx: Pick<Ctx, 'db' | 'config'>, input: NewContact, now = new Date()): Promise<{ contactId: string; permissionId: string | null }> {
  const address = readAddress(input.kind, input.address);
  const addressHash = recipientDigest(address);
  return ctx.db.transaction(async tx => {
    await tx.insert(outboundContacts).values({ companyId: input.companyId, kind: input.kind, addressEnc: encryptSecret(address, ctx.config.secret), addressHash }).onConflictDoNothing();
    const [contact] = await tx.select().from(outboundContacts).where(and(eq(outboundContacts.companyId, input.companyId), eq(outboundContacts.kind, input.kind), eq(outboundContacts.addressHash, addressHash))).for('update');
    if (contact!.doNotContact) throw new ApiError(409, 'conflict', 'This contact asked not to be written to. An import does not change that.', 'outbound_conflict', { reasonCodes: ['contact_suppressed'] });
    const evidenceDigest = digestOf(input.evidence);
    const [permission] = await tx.insert(outboundPermissions).values({ companyId: input.companyId, contactId: contact!.id, channelId: input.channel.id, purpose: input.channel.purpose, source: input.source, evidenceDigest }).onConflictDoNothing().returning();
    await record(tx, { contact: contact!, kind: 'consent_granted', dedupKey: `consent:${contact!.id}:${input.channel.id}:${input.channel.purpose}:${evidenceDigest}`, evidenceDigest, now });
    return { contactId: contact!.id, permissionId: permission?.id ?? null };
  });
}

/* The place a permission is of: that of its channel. */
export async function permissionPlace(db: Pick<Db, 'select'>, companyId: string, permissionId: string): Promise<{ departmentId: string }> {
  const [place] = await db.select({ departmentId: outboundChannels.departmentId }).from(outboundPermissions).innerJoin(outboundChannels, eq(outboundChannels.id, outboundPermissions.channelId)).where(and(eq(outboundPermissions.id, permissionId), eq(outboundPermissions.companyId, companyId)));
  if (!place) throw notFound();
  return place;
}

/* A permission taken back. A message waiting on it finds out at its last look. */
export async function revokePermission(ctx: Pick<Ctx, 'db'>, at: { companyId: string; permissionId: string }, now = new Date()): Promise<void> {
  await ctx.db.transaction(async tx => {
    const [permission] = await tx.select().from(outboundPermissions).where(and(eq(outboundPermissions.id, at.permissionId), eq(outboundPermissions.companyId, at.companyId)));
    if (!permission) throw notFound();
    const contact = await theContact(tx, at.companyId, permission.contactId);
    await tx.update(outboundPermissions).set({ status: 'revoked', revokedAt: now }).where(and(eq(outboundPermissions.id, permission.id), eq(outboundPermissions.status, 'granted')));
    await record(tx, { contact, kind: 'consent_revoked', dedupKey: `revoke:${permission.id}`, evidenceDigest: digestOf(permission.id), now });
  });
}

/* A refusal, once: no more permissions, and what waits for this contact is cancelled in the same step. The contact is held,
   so that it comes either wholly before or wholly after a dispatch's last look. */
async function refuseFromNowOn(tx: Tx, s: Said): Promise<void> {
  if (!s.contact.doNotContact) await tx.update(outboundContacts).set({ doNotContact: true, suppressedAt: s.now }).where(eq(outboundContacts.id, s.contact.id));
  await tx.update(outboundPermissions).set({ status: 'revoked', revokedAt: s.now }).where(and(eq(outboundPermissions.contactId, s.contact.id), eq(outboundPermissions.status, 'granted')));
  await record(tx, s);
  await cancelQueuedTo(tx, s.contact.id, 'contact_suppressed', s.now);
}

/* A person marks a contact do not contact. */
export async function suppressContact(ctx: Pick<Ctx, 'db'>, at: { companyId: string; contactId: string; evidenceDigest: string }, now = new Date()): Promise<void> {
  await ctx.db.transaction(async tx => {
    const contact = await theContact(tx, at.companyId, at.contactId);
    await refuseFromNowOn(tx, { contact, kind: 'suppressed', dedupKey: `suppress:${contact.id}`, evidenceDigest: at.evidenceDigest, now });
  });
}

/* What a stop link is about. It holds ids and no address, and it grants opting out and nothing else. */
export type UnsubscribeTarget = { companyId: string; contactId: string; channelId: string; purpose: string };
const TokenBody = z.strictObject({ c: z.uuid(), k: z.uuid(), h: z.uuid(), p: z.string().min(1) });

/* Its own purpose, so that no other signature of this server is ever one of these. */
const UNSUBSCRIBE = 'hornhoof outbound unsubscribe v1';

export const unsubscribeToken = (secret: Buffer, t: UnsubscribeTarget): string => signedToken(secret, UNSUBSCRIBE, { c: t.companyId, k: t.contactId, h: t.channelId, p: t.purpose });

export function readUnsubscribeToken(secret: Buffer, token: string): UnsubscribeTarget | null {
  const body = TokenBody.safeParse(signedBody(secret, UNSUBSCRIBE, token));
  return body.success ? { companyId: body.data.c, contactId: body.data.k, channelId: body.data.h, purpose: body.data.p } : null;
}

/* The address a message carries; none where this server cannot be reached safely from a mail. */
export const unsubscribeUrl = (base: string, secret: Buffer, t: UnsubscribeTarget): string | null => (base.startsWith('https://') ? `${base}/api/outbound/unsubscribe/${unsubscribeToken(secret, t)}` : null);

/* A verified opt-out wins over everything that comes after it. Following the link again changes nothing. */
export async function unsubscribe(ctx: Pick<Ctx, 'db' | 'config'>, token: string, now = new Date()): Promise<boolean> {
  const target = readUnsubscribeToken(ctx.config.secret, token);
  if (!target) return false;
  return ctx.db.transaction(async tx => {
    const [contact] = await tx.select().from(outboundContacts).where(and(eq(outboundContacts.id, target.contactId), eq(outboundContacts.companyId, target.companyId))).for('update');
    if (!contact) return false;
    await refuseFromNowOn(tx, { contact, kind: 'unsubscribed', dedupKey: `unsubscribe:${contact.id}`, evidenceDigest: digestOf({ channel: target.channelId, purpose: target.purpose }), now });
    return true;
  });
}
