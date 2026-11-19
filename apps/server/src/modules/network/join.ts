import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { certificates, machineOnline, machines, machineTickets, nodeCodes, peerSecrets, people, publicLinks, type MachineRole } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError, loggable } from '../../errors.js';
import { dropAccess } from '../computer/access.js';
import { holdsData } from '../copies/holds.js';
import { copyOrder } from '../copies/slots.js';
import type { CopyOrder } from '../keeper/copy.js';
import { Server } from '../link/client.js';
import { tunnelSettings } from '../link/link.js';
import { CERT_DAYS, readEd25519PublicKey, RENEW_AFTER_DAYS, type Issued } from './authority.js';
import type { Go, LeaderBuild } from './follow.js';
import { joinMessage } from './join-proof.js';
import { renewedMessage, renewMessage, type Signed } from './renewal.js';
import { authorityOf, certify, makeAuthorityOnce, networkMachine, peerSecret, revokedSerials } from './store.js';

const TICKET_HOURS = 24;
const RENEW_WINDOW_MS = 5 * 60_000;
const ONLINE_STEP_S = 20;

const HOUR_MS = 3_600_000;
const DAY_S = 86_400;
const DAY_MS = DAY_S * 1000;
/* A report this soon after the one before adds no online time: a keeper reports every 20 seconds. */
const SAME_REPORT_MS = 15_000;
const ONLINE_KEPT_DAYS = 8;
const SHARE_DAYS = 7;
/* The relay is asked for a visitor key this often at most, unless a machine was just cut off. */
const VISITOR_KEY_EVERY_MS = 60_000;

export const notAMachine = () => new ApiError(404, 'not_found', "This machine is not one of the company's network.", 'not_a_machine');
const ticketUsed = () => new ApiError(410, 'gone', 'This join ticket was used or has expired. Run the command from Hornhoof again.', 'ticket_used');
const joinRefused = () => new ApiError(401, 'unauthorized', 'This join request is not signed by the machine.', 'join_refused');
const machineTaken = () => new ApiError(409, 'conflict', 'This computer is in the company under another row already. Disconnect that one first.', 'machine_taken');
const renewRefused = () => new ApiError(401, 'unauthorized', 'This renewal is not signed by the machine, or is too old.', 'renew_refused');
const notLeading = () => new ApiError(503, 'unavailable', 'This server does not lead the company now. Try again in a few seconds.');

/* The id install.sh gives a computer's keeper: the hash of the key the computer joined with. */
export const hostIdOf = (machineKey: string): string => hashToken(`hornhoof-host:${machineKey}`);

/* Whether a computer, by the key it joined with, is the one this server itself runs on. */
export function isServerComputer(config: Config, machineKey: string): boolean {
  const id = hostIdOf(machineKey);
  return id === config.hostId || id === config.machineId;
}

/* The folder a joined machine keeps the company's core in: named after the link, else after six letters drawn from the
   company's id, the same on every machine, so a company never wants the folder of a server installed there. */
export function companyFolder(linkName: string | null, companyId: string): string {
  if (linkName) return `hornhoof-${linkName}`;
  const digest = createHash('sha256').update(companyId).digest();
  return `hornhoof-${[...digest.subarray(0, 6)].map(byte => String.fromCharCode(97 + (byte % 26))).join('')}`;
}

/* A ticket the machine's keeper redeems once for its first certificate. Only its hash is kept. */
export async function issueTicket(tx: Db, machineId: string, now = new Date()): Promise<string> {
  const ticket = newToken();
  await tx.insert(machineTickets).values({ ticketHash: hashToken(ticket), machineId, expiresAt: new Date(now.getTime() + TICKET_HOURS * HOUR_MS) });
  return ticket;
}

export { renewMessage, renewedMessage, type Signed } from './renewal.js';
type RenewAsk = { machine: string; serial: string; at: string };

/* A renewal travels over plain HTTP too, so the machine takes its answer only with the signature of the authority it
   holds: a path that changes the answer only makes the renewal fail. */
async function signedAnswer(ctx: Ctx, ask: RenewAsk, body: object): Promise<Signed> {
  const authority = await authorityOf(ctx.db, ctx.config);
  if (!authority) throw notAMachine();
  const payload = JSON.stringify(body);
  const signature = sign(null, Buffer.from(renewedMessage(ask.machine, ask.serial, ask.at, payload)), createPrivateKey(authority.keyPem));
  return { payload, signature: signature.toString('base64') };
}

/* The machine's row, held until the transaction ends; null for an unknown or disconnected one. Every certificate is
   issued under this lock, and Disconnect changes the row first, so no certificate is issued past a Disconnect. */
export async function lockLiveMachine(tx: Db, machineId: string): Promise<typeof machines.$inferSelect | null> {
  const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update');
  return row && !row.revokedAt ? row : null;
}

/* Deletes the secrets of the peer services and the visitor key, and nothing else. The leader makes new ones on its next
   use, so what a machine that was cut off still holds opens nothing. */
export async function dropPeerSecrets(tx: Db): Promise<void> {
  await tx.delete(peerSecrets).where(inArray(peerSecrets.kind, ['data', 'app', 'visit']));
}

/* Disconnect's part for the network, in its transaction and after it marked the rows: the machines' certificates are
   revoked, a worker gives its computer up, and its unused tickets and commands end. Whether any of them had the core,
   and so held the secrets, which then go as well. */
export async function revokeMachineRows(tx: Db, machineIds: string[], now: Date): Promise<boolean> {
  if (machineIds.length === 0) return false;
  const these = inArray(machines.id, machineIds);
  const cored = await tx.select(idOnly(machines)).from(machines).where(and(these, isNotNull(machines.networkId)));
  await tx.update(certificates).set({ revokedAt: now }).where(and(inArray(certificates.machineId, machineIds), isNull(certificates.revokedAt)));
  await dropAccess(tx, machineIds, now);
  await tx.update(machines).set({ networkId: null }).where(and(these, eq(machines.role, 'worker')));
  await tx.delete(machineTickets).where(and(inArray(machineTickets.machineId, machineIds), isNull(machineTickets.usedAt)));
  await tx.update(nodeCodes).set({ usedAt: now }).where(and(inArray(nodeCodes.machineId, machineIds), isNull(nodeCodes.usedAt)));
  if (cored.length > 0) await dropPeerSecrets(tx);
  return cored.length > 0;
}

/* number: its place in taking the server, 1 for the one that leads. copyName: the name its copy's subscription goes by. */
export type DataMachine = { machine: string; networkId: string; hostname: string | null; addresses: string[]; peerPort: number | null; webPort: number | null; number: number | null; copyName: string | null };
/* dataSecret: the secret of the data machines' other service, the way to the data, for a machine that holds it too. */
/* hidden: a name the company's machines use and people do not: nothing but who holds the lease is answered at it, so
   no machine follows its address. A server from before hidden names says nothing of it. */
export type WorkerLink = { name: string; url: string; serverAddr: string; serverPort: number; appSecret: string; visitorKey: string; dataSecret: string | null; hidden?: boolean };
/* link: null when the company has no link; left out when it has one that cannot be told now, so whoever reads the view
   keeps the link it has. */
/* copy: what the leader says of this machine's copy, or of what it owes after it stopped keeping one; null for a
   machine that keeps none. */
export type WorkerView = { machine: string; role: MachineRole; authorityPem: string | null; revoked: string[]; data: DataMachine[]; link?: WorkerLink | null; build: LeaderBuild | null; go: Go | null; copy: CopyOrder | null };

/* The machines that keep the company's data, with where their keepers said they are: the ones a worker dials. */
export async function dataMachines(db: Db): Promise<DataMachine[]> {
  const rows = await db
    .select()
    .from(machines)
    .where(and(isNull(machines.revokedAt), eq(machines.role, 'data'), isNotNull(machines.networkId)))
    .orderBy(asc(machines.createdAt), asc(machines.id));
  return rows.map(row => ({ machine: row.id, networkId: row.networkId!, hostname: row.hostname || null, addresses: row.addresses, peerPort: row.peerPort, webPort: row.webPort, number: row.serverOrder, copyName: row.copyName }));
}

const VisitSecret = z.object({ name: z.string(), key: z.string() });
type Asking = { queue: Promise<unknown>; askedAt: number; failed: boolean };
const asking = new WeakMap<Ctx, Asking>();

async function readOrAskVisitorKey(ctx: Ctx, state: Asking, force: boolean): Promise<string | null> {
  const { db, config } = ctx;
  const [link] = await db.select({ name: publicLinks.name, keyEnc: publicLinks.keyEnc }).from(publicLinks).limit(1);
  if (!link) return null;
  const [kept] = force ? [] : await db.select().from(peerSecrets).where(eq(peerSecrets.kind, 'visit'));
  const stored = kept ? VisitSecret.safeParse(JSON.parse(decryptSecret(kept.secretEnc, config.secret))) : null;
  if (stored?.success && stored.data.name === link.name) return stored.data.key;
  if (ctx.mode.current() !== 'lead') return null;
  if (!force && Date.now() - state.askedAt < VISITOR_KEY_EVERY_MS) return null;
  state.askedAt = Date.now();
  const key = await ctx.links.relay.visitorKey(link.name, decryptSecret(link.keyEnc, config.secret));
  const secretEnc = encryptSecret(JSON.stringify({ name: link.name, key }), config.secret);
  await db.insert(peerSecrets).values({ kind: 'visit', secretEnc }).onConflictDoUpdate({ target: peerSecrets.kind, set: { secretEnc, createdAt: new Date() } });
  return key;
}

/* The key a worker's frpc logs in at the relay with, to reach the server's services there and offer none: the one kept
   for this link, else, while leading, a new one from the relay, which ends the one before. One ask at a time and one a
   minute at most; force asks at once and whatever is kept, as after a Disconnect, whose machine still holds the old key.
   null without a link or a key, and a relay that fails is named in the log once. */
export function visitorKeyOf(ctx: Ctx, opts: { force?: boolean } = {}): Promise<string | null> {
  const state = asking.get(ctx) ?? { queue: Promise.resolve(), askedAt: -Infinity, failed: false };
  asking.set(ctx, state);
  const answer = state.queue.then(async () => {
    try {
      const key = await readOrAskVisitorKey(ctx, state, opts.force ?? false);
      state.failed = false;
      return key;
    } catch (err) {
      if (!state.failed) ctx.log.warn({ error: loggable(err) }, 'Could not get a visitor key from hornhoof.org, so machines elsewhere do not reach this server through it yet.');
      state.failed = true;
      return null;
    }
  });
  state.queue = answer;
  return answer;
}

/* The public link as a worker uses it, with neither the link's key nor the way to the data. Null: the company has no
   link. Undefined: it has one, but this app cannot tell it now, since it does not lead and so makes no secret, or the
   relay has given no visitor key yet. */
export async function workerLink(ctx: Ctx, withData = false): Promise<WorkerLink | null | undefined> {
  const settings = await tunnelSettings(ctx.db, ctx.config);
  if (!settings) return null;
  if (ctx.mode.current() !== 'lead') return undefined;
  const server = Server.safeParse(settings.tunnel);
  const appSecret = await peerSecret(ctx.db, ctx.config, 'app', true);
  const visitorKey = await visitorKeyOf(ctx);
  if (!server.success || !appSecret || !visitorKey) return undefined;
  const dataSecret = withData ? await peerSecret(ctx.db, ctx.config, 'data', true) : null;
  return { name: settings.name, url: settings.url, serverAddr: server.data.serverAddr, serverPort: server.data.serverPort, appSecret, visitorKey, dataSecret, hidden: settings.hidden === true };
}

/* What a worker knows of the network: who it is, whom to trust and whom not, where the data machines are, and the link.
   The server's build and the word to install it are told only through the peer link, to the machine's own keeper: a view
   that goes with a join or a renewal carries none. */
export async function workerView(ctx: Ctx, machineId: string): Promise<WorkerView> {
  const row = await networkMachine(ctx.db, machineId);
  if (!row) throw notAMachine();
  const authority = await authorityOf(ctx.db, ctx.config);
  const link = await workerLink(ctx, row.role === 'data' && (await holdsData(ctx.db, row.personId)));
  const copy = row.role === 'data' || row.uploadState ? await copyOrder(ctx, row) : null;
  return { machine: row.id, role: row.role!, authorityPem: authority?.certPem ?? null, revoked: await revokedSerials(ctx.db), data: await dataMachines(ctx.db), ...(link === undefined ? {} : { link }), build: null, go: null, copy };
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/* One report is 20 seconds online on its UTC day, up to a whole day. A second report right after the one before, as of a
   keeper started twice, adds nothing. Days too old for the share go. */
export async function countOnline(tx: Db, machineId: string, prevReportAt: Date | null, now = new Date()): Promise<void> {
  if (prevReportAt && now.getTime() - prevReportAt.getTime() < SAME_REPORT_MS) return;
  await tx
    .insert(machineOnline)
    .values({ machineId, day: dayOf(now), seconds: ONLINE_STEP_S })
    .onConflictDoUpdate({ target: [machineOnline.machineId, machineOnline.day], set: { seconds: sql`LEAST(${DAY_S}, ${machineOnline.seconds} + ${ONLINE_STEP_S})` } });
  await tx.delete(machineOnline).where(and(eq(machineOnline.machineId, machineId), lt(machineOnline.day, dayOf(new Date(now.getTime() - ONLINE_KEPT_DAYS * DAY_MS)))));
}

/* The share of the last week the machine was online, 0 to 1, or of its life when it is younger; null for a machine under
   a minute old. The window begins inside a day, and that day's seconds count by the part of it inside the window, out of
   the part of it the machine was there at all. */
export async function onlineShare(db: Db, machineId: string, now = new Date()): Promise<number | null> {
  const [row] = await db.select(only(machines, 'createdAt')).from(machines).where(eq(machines.id, machineId));
  if (!row) return null;
  const days = await db.select().from(machineOnline).where(and(eq(machineOnline.machineId, machineId), gte(machineOnline.day, dayOf(new Date(now.getTime() - SHARE_DAYS * DAY_MS))), lte(machineOnline.day, dayOf(now))));
  return shareOf(row.createdAt, days, now);
}

/* The same for every live machine, from one look at their days. */
export async function onlineShares(db: Db, now = new Date()): Promise<Map<string, number | null>> {
  const rows = await db.select({ id: machines.id, createdAt: machines.createdAt }).from(machines).where(isNull(machines.revokedAt));
  const days = await db.select().from(machineOnline).where(and(gte(machineOnline.day, dayOf(new Date(now.getTime() - SHARE_DAYS * DAY_MS))), lte(machineOnline.day, dayOf(now))));
  const byMachine = new Map<string, typeof days>();
  for (const day of days) byMachine.set(day.machineId, [...(byMachine.get(day.machineId) ?? []), day]);
  return new Map(rows.map(row => [row.id, shareOf(row.createdAt, byMachine.get(row.id) ?? [], now)]));
}

function shareOf(createdAt: Date, days: { day: string; seconds: number }[], now: Date): number | null {
  const start = Math.max(now.getTime() - SHARE_DAYS * DAY_MS, createdAt.getTime());
  const length = now.getTime() - start;
  if (length < 60_000) return null;
  const firstDay = dayOf(new Date(start));
  const firstDayStart = Date.parse(`${firstDay}T00:00:00Z`);
  const firstDayEnd = Math.min(firstDayStart + DAY_MS, now.getTime());
  const firstDayShare = (firstDayEnd - start) / (firstDayEnd - Math.max(firstDayStart, createdAt.getTime()));
  const online = days.filter(({ day }) => day >= firstDay).reduce((sum, { day, seconds }) => sum + (day === firstDay ? seconds * firstDayShare : seconds), 0);
  return Math.min(1, Math.max(0, (online * 1000) / length));
}

type JoinAsk = { ticket: string; networkId: string; signKey: string; signature: string };
type Certified = { machine: string; role: MachineRole; issued: Issued; authorityPem: string };

/* A machine's keeper redeems its ticket: the ticket's machine becomes a worker of the network under the id of its
   computer, with the key the keeper holds, and gets its first certificate. The ticket works once, for the computer it
   was made on, while its machine is connected and its person active. The key must sign the request, and the claim rolls
   back if the certificate cannot be issued. A computer has one row in the network: a second person's row on it waits
   until the first is disconnected. */
export async function redeemTicket(ctx: Ctx, ask: JoinAsk): Promise<Certified> {
  if (ctx.mode.current() !== 'lead') throw notLeading();
  const key = readEd25519PublicKey(ask.signKey);
  if (!key || !verify(null, Buffer.from(joinMessage(ask.ticket, ask.networkId)), key, Buffer.from(ask.signature, 'base64'))) throw joinRefused();
  const signKey = key.export({ type: 'spki', format: 'pem' }).toString();
  const hash = hashToken(ask.ticket);
  const join = ctx.db.transaction(async tx => {
    /* The machine's row first and the ticket after it, as Disconnect takes them: the other way round the two would wait
       on each other. */
    const [named] = await tx.select(only(machineTickets, 'machineId')).from(machineTickets).where(eq(machineTickets.ticketHash, hash));
    const row = named ? await lockLiveMachine(tx, named.machineId) : null;
    if (!row) throw ticketUsed();
    const now = new Date();
    const [claimed] = await tx.update(machineTickets).set({ usedAt: now })
      .where(and(eq(machineTickets.ticketHash, hash), isNull(machineTickets.usedAt), gt(machineTickets.expiresAt, now)))
      .returning({ ticketHash: machineTickets.ticketHash });
    if (!claimed) throw ticketUsed();
    const [person] = await tx.select(only(people, 'status')).from(people).where(eq(people.id, row.personId));
    if (person?.status !== 'active') throw ticketUsed();
    if (ask.networkId !== hostIdOf(row.machineKey)) throw machineTaken();
    /* A disconnected row that still names this computer gives it up. A live one keeps it: its row is not locked here,
       and one that takes the id in this very moment is met by the column's unique rule below. */
    const holders = await tx.select({ id: machines.id, revokedAt: machines.revokedAt }).from(machines).where(and(eq(machines.networkId, ask.networkId), ne(machines.id, row.id)));
    if (holders.some(holder => !holder.revokedAt)) throw machineTaken();
    if (holders.length > 0) await tx.update(machines).set({ networkId: null }).where(inArray(machines.id, holders.map(holder => holder.id)));
    await tx.update(machines).set({ networkId: ask.networkId, role: 'worker', signKey }).where(eq(machines.id, row.id));
    /* A core installed anew has a new key, and what the old key held ends with it. */
    if (row.signKey && row.signKey !== signKey) await tx.update(certificates).set({ revokedAt: now }).where(and(eq(certificates.machineId, row.id), isNull(certificates.revokedAt)));
    const authority = await makeAuthorityOnce(tx, ctx.config, row.companyId);
    const issued = await certify(tx, authority, { id: row.id, role: 'worker', signKey });
    return { machine: row.id, role: 'worker' as const, issued, authorityPem: authority.certPem };
  });
  return join.catch((err: unknown) => {
    throw isUniqueViolation(err) ? machineTaken() : err;
  });
}

function signedByMachine(signKey: string, ask: RenewAsk & { signature: string }): boolean {
  try {
    return verify(null, Buffer.from(renewMessage(ask.machine, ask.serial, ask.at)), createPublicKey(signKey), Buffer.from(ask.signature, 'base64'));
  } catch {
    return false;
  }
}

/* A signed renewal counts once: a later moment than the last one taken. The row is locked, so of two at once one counts. */
export async function claimRenewal(tx: Db, row: { id: string; renewAt: Date | null }, at: Date): Promise<boolean> {
  if (row.renewAt && row.renewAt.getTime() >= at.getTime()) return false;
  await tx.update(machines).set({ renewAt: at }).where(eq(machines.id, row.id));
  return true;
}

type RenewAnswer = { status: 200 | 410; answer: Signed };

/* The view as an answer may carry it: the link's secrets go only into one that travels over TLS, so a listener on the
   local network sees none, and the machine keeps the link it has. */
export function viewFor(view: WorkerView, overTls: boolean): WorkerView {
  if (overTls) return view;
  const open = { ...view };
  delete open.link;
  return open;
}

/* A machine asks for its view of the network, and for a new certificate when the one it names is unknown, revoked or
   near its end, by a request signed with its own key: its certificate may have expired, or the secrets changed, so it
   cannot come through the peer link. A disconnected machine that proves its key learns that it was cut off, and nobody
   else does. withLink: the answer travels over TLS, so it may carry the link's secrets. */
export async function signedRenewal(ctx: Ctx, ask: RenewAsk & { signature: string }, withLink: boolean): Promise<RenewAnswer> {
  const at = new Date(ask.at);
  const now = new Date();
  const taken = await ctx.db.transaction(async tx => {
    const row = await lockLiveMachine(tx, ask.machine);
    if (!row) {
      const [gone] = await tx.select(only(machines, 'signKey')).from(machines).where(and(eq(machines.id, ask.machine), isNotNull(machines.revokedAt)));
      if (gone?.signKey && signedByMachine(gone.signKey, ask)) return null;
      throw notAMachine();
    }
    if (!row.role || !row.signKey) throw notAMachine();
    const fresh = Math.abs(now.getTime() - at.getTime()) <= RENEW_WINDOW_MS;
    if (!signedByMachine(row.signKey, ask) || !fresh || !(await claimRenewal(tx, row, at))) throw renewRefused();
    const [held] = await tx.select().from(certificates).where(and(eq(certificates.serial, ask.serial), eq(certificates.machineId, row.id), isNull(certificates.revokedAt), gt(certificates.until, now)));
    const due = !held || held.until.getTime() - now.getTime() < (CERT_DAYS - RENEW_AFTER_DAYS) * DAY_MS;
    const authority = await makeAuthorityOnce(tx, ctx.config, row.companyId);
    /* As with a certificate asked through the peer link: one that opens the data goes only to a row whose person sees
       the whole company, whatever the row still says. */
    const role = row.role === 'data' && !(await holdsData(tx, row.personId)) ? 'worker' : row.role;
    const issued = due ? await certify(tx, authority, { id: row.id, role, signKey: row.signKey }) : null;
    return { role, issued, authorityPem: authority.certPem };
  });
  if (!taken) return { status: 410, answer: await signedAnswer(ctx, ask, { disconnected: true }) };
  const body = {
    machine: ask.machine, serial: ask.serial, at: ask.at, role: taken.role, authorityPem: taken.authorityPem,
    certPem: taken.issued?.certPem ?? null, until: taken.issued?.until.toISOString() ?? null,
    view: viewFor(await workerView(ctx, ask.machine), withLink),
  };
  return { status: 200, answer: await signedAnswer(ctx, ask, body) };
}
