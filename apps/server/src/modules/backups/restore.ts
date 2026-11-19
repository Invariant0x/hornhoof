import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { personColumns, type Person } from '../../auth/session.js';
import { idOnly, only } from '../../db/selections.js';
import type { Mode } from '../keeper/state.js';
import type { Db } from '../../db/client.js';
import { MIGRATIONS } from '../../db/client.js';
import { assistants, certificates, companies, computerRuns, departments, invites, machineAccess, machines, nodes, PEER_SECRET_KINDS, peerSecrets, people, personAccess, publicLinks, recoveryKeys, sessions, teams } from '../../db/schema.js';
import { ApiError, loggable, type ErrorReason } from '../../errors.js';
import { writeChoice } from '../merge/kept.js';
import { authorityOf, findThisMachine } from '../network/store.js';
import { disconnectMachines } from '../nodes/disconnect.js';
import { liveNode, settlePlans } from '../nodes/nodes.js';
import { carryRemoval, disablePerson } from '../people/routes.js';
import type { Manifest } from './bundle.js';
import { parseRecoveryFile, type RecoveryFile } from './recovery.js';
import { bundleRow, type BackupRow } from './records.js';
import type { Carry, RestoreOrder, RestoreStatus, RestoreStep } from './types.js';

/* An order the keeper has not ended within this long is let go, and with it a recovery identity it carries. */
export const ORDER_MS = 3_600_000;
export const RESTORE_STATUS = 'restore-status.json';
export const RESTORE_CARRY = 'restore-carry.json';
/* A machine that reported within this long is online. */
const ONLINE_MS = 2 * 60_000;
/* The steps the keeper takes, which count only while the app holds their order; the updater's follow them. */
const KEEPER_STEPS: readonly RestoreStep[] = ['fetch', 'check', 'open'];
const CALLED_OFF = 'The restore was called off.';

type NotRestorable = 'newer_build' | 'not_held' | 'needs_recovery_file';

/* How many migrations this build knows: a backup of a database with more was made by a newer one. Read once, as a
   build's migrations never change while it runs. */
let known: number | undefined;
export function knownMigrations(): number {
  known ??= (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;
  return known;
}

/* A file of the control folder as JSON. Null when there is none; it throws when one is there and cannot be read. */
function controlJson<T>(dir: string, name: string): T | null {
  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text) as T;
}

/* What the keeper and the updater last said of a restore; null when they said nothing that can be read. */
export function readRestoreStatus(controlDir: string): RestoreStatus | null {
  try {
    return controlJson<RestoreStatus>(controlDir, RESTORE_STATUS);
  } catch {
    return null;
  }
}

/* Who may get in now, put into a database that was restored from an earlier time: a restore never brings back a person
   who was disabled or removed since, a password that was changed, a machine that was disconnected, a recovery file that was
   replaced or an assistant's or node's key that was revoked, cleared or replaced. Removed accounts leave a record even if
   the backup predates them. Owners' machine settings carry forward; employee computer grants and sessions end. */
export async function applyCarry(ctx: Ctx, carry: Carry): Promise<void> {
  const { db } = ctx;
  const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
  if (!company) return;
  const here = await db.select({ id: people.id, status: people.status }).from(people);
  const known = new Map(here.map(person => [person.id, person.status]));
  const [placesD, placesT] = [new Set((await db.select(idOnly(departments)).from(departments)).map(row => row.id)), new Set((await db.select(idOnly(teams)).from(teams)).map(row => row.id))];
  /* Who stopped being the owner first, so the company never has two. */
  const theirs = carry.people.filter(person => known.has(person.id)).sort((a, b) => Number(a.isOwner) - Number(b.isOwner));
  for (const person of theirs) {
    if (person.removedAt) continue;
    if (person.status === 'disabled') {
      if (known.get(person.id) !== 'disabled') await disablePerson(ctx, person.id);
      continue;
    }
    await db.transaction(async tx => {
      const now = { status: person.status, passwordHash: person.passwordHash, scopeKind: person.scopeKind as Person['scopeKind'], isOwner: person.isOwner, isCeoDelegate: person.isCeoDelegate };
      const [present] = await tx.update(people).set(now).where(and(eq(people.id, person.id), isNull(people.removedAt))).returning(idOnly(people));
      if (!present) return;
      await tx.delete(personAccess).where(eq(personAccess.personId, person.id));
      const rows = person.access
        .filter(place => (place.departmentId === null || placesD.has(place.departmentId)) && (place.teamId === null || placesT.has(place.teamId)))
        .map(place => ({ companyId: company.id, personId: person.id, departmentId: place.departmentId, teamId: place.teamId }));
      if (rows.length > 0) await tx.insert(personAccess).values(rows);
    });
  }
  const removed = carry.people.flatMap(person => person.removedAt ? [{ ...person, removedAt: new Date(person.removedAt) }] : []);
  if (removed.length) {
    const [owner] = await db.select(personColumns).from(people).where(and(eq(people.companyId, company.id), eq(people.isOwner, true)));
    if (!owner) throw new Error('Cannot carry permanent removals without the company owner.');
    for (const person of removed) {
      if (known.has(person.id)) await carryRemoval(ctx, person.id, owner, person.removedAt);
      /* Keep the removal even in a bundle made before this account existed, so a later restore still carries it. */
      else await db.insert(people).values({ id: person.id, companyId: company.id, name: person.removedName ?? '', status: 'disabled', scopeKind: 'listed', removedAt: person.removedAt }).onConflictDoNothing({ target: people.id });
    }
  }
  /* An invite that was used or called off since is not open again. */
  await db.delete(invites).where(and(isNull(invites.usedAt), carry.invites.length > 0 ? notInArray(invites.tokenHash, carry.invites) : undefined));
  const live = new Set((await db.select(idOnly(machines)).from(machines).where(isNull(machines.revokedAt))).map(row => row.id));
  await disconnectMachines(ctx, carry.machines.filter(machine => machine.revoked && live.has(machine.id)).map(machine => machine.id));
  for (const machine of carry.machines) await db.update(machines).set({
    lendsTests: machine.lendsTests,
    keepsBackups: machine.keepsBackups,
    ...(typeof machine.computerClosed === 'boolean' ? { computerClosed: machine.computerClosed } : {}),
    ...holdsNow(machine),
  }).where(eq(machines.id, machine.id));
  await carryLink(db, company.id, carry);
  const now = new Date();
  if (carry.serials.length > 0) await db.update(certificates).set({ revokedAt: now }).where(and(inArray(certificates.serial, carry.serials), isNull(certificates.revokedAt)));
  await carryRecoveryKeys(db, company.id, carry, known, now);
  await carryAssistantKeys(db, carry);
  await carryNodeKeys(db, carry);
  await db.transaction(async tx => {
    await tx.delete(machineAccess);
    await tx.update(computerRuns).set({ state: 'lost' }).where(inArray(computerRuns.state, ['waiting', 'sent']));
    await tx.delete(sessions);
  });
  ctx.bus.accessChanged(company.id);
  ctx.bus.publish(company.id, { type: 'org' });
  ctx.bus.publish(company.id, { type: 'computer' });
}

/* Whether a machine holds the company's data now, as the old database had it when it closed: an older bundle would
   else give the data back to a machine that stopped holding it. One that holds it no more has no place either; the
   ranking gives the places anew. */
function holdsNow(machine: Carry['machines'][number]): Partial<typeof machines.$inferInsert> {
  if (machine.role === undefined) return {};
  const left = machine.role !== 'data' ? { serverOrder: null, serverWhy: null } : {};
  return { role: machine.role, dataLeftAt: machine.dataLeftAt ? new Date(machine.dataLeftAt) : null, uploadState: machine.uploadState ?? null, ...left };
}

/* A time as the database that closed gave it, written back whole: through a Date it would lose its microseconds, and
   the restored row would differ from the one that database holds when it is merged. */
const timeOf = (text: string) => sql<Date>`${text}::timestamptz`;

/* The link and the secrets of the peer services as they were when the old database closed: the key the relay takes
   now, a change of it that was under way, and secrets no machine that left knows. A company that has no link now gets
   none back. */
async function carryLink(db: Db, companyId: string, carry: Carry): Promise<void> {
  await db.transaction(async tx => {
    if (carry.link === null) await tx.delete(publicLinks);
    else if (carry.link) {
      /* A carry of a build from before hidden names says nothing of it: that link was a public one. */
      const row = { name: carry.link.name, url: carry.link.url, hidden: carry.link.hidden === true, keyEnc: carry.link.keyEnc, nextKeyEnc: carry.link.nextKeyEnc, tunnelEnc: carry.link.tunnelEnc, createdAt: timeOf(carry.link.createdAt) };
      await tx.insert(publicLinks).values({ companyId, ...row }).onConflictDoUpdate({ target: publicLinks.companyId, set: row });
    }
    if (!carry.peerSecrets) return;
    await tx.delete(peerSecrets);
    /* Only the kinds this build knows: a kind of a later one would not fit the table. */
    /* A carry of a build from before names no time for a secret: that one counts from now. */
    const known = carry.peerSecrets.flatMap(secret => PEER_SECRET_KINDS.filter(kind => kind === secret.kind).map(kind => ({ kind, secretEnc: secret.secretEnc, ...(secret.createdAt ? { createdAt: timeOf(secret.createdAt) } : {}) })));
    if (known.length > 0) await tx.insert(peerSecrets).values(known);
  });
}

/* The recovery keys as they were when the old database closed: its rows by their ids, and every other one retired. */
async function carryRecoveryKeys(db: Db, companyId: string, carry: Carry, known: Map<string, string>, now: Date): Promise<void> {
  const [owner] = await db.select(idOnly(people)).from(people).where(eq(people.isOwner, true)).limit(1);
  await db.transaction(async tx => {
    const ids = carry.recoveryKeys.map(key => key.id);
    await tx.update(recoveryKeys).set({ retiredAt: now }).where(and(isNull(recoveryKeys.retiredAt), ids.length > 0 ? notInArray(recoveryKeys.id, ids) : undefined));
    for (const key of carry.recoveryKeys) {
      const madeBy = known.has(key.madeBy) ? key.madeBy : owner?.id;
      if (!madeBy) continue;
      const row = { recipient: key.recipient, linkPrint: key.linkPrint, linkName: key.linkName, linkUrl: key.linkUrl, madeBy, madeAt: new Date(key.madeAt), retiredAt: key.retiredAt ? new Date(key.retiredAt) : null };
      await tx.delete(recoveryKeys).where(and(eq(recoveryKeys.recipient, key.recipient), ne(recoveryKeys.id, key.id)));
      await tx.insert(recoveryKeys).values({ id: key.id, companyId, ...row }).onConflictDoUpdate({ target: recoveryKeys.id, set: row });
    }
  });
}

/* The assistants' keys as they were when the old database closed: a key revoked or replaced since opens nothing, and
   the one that opened something then works on. An assistant made since is not in the restored database, nor is its key. */
async function carryAssistantKeys(db: Db, carry: Carry): Promise<void> {
  const keys = carry.assistantKeys;
  if (!keys) return;
  await db.transaction(async tx => {
    await tx.update(assistants).set({ keyHash: null, keyCreatedAt: null, wakeSecretEnc: null }).where(isNotNull(assistants.keyHash));
    for (const key of keys) {
      await tx.update(assistants).set({ keyHash: key.keyHash, keyCreatedAt: timeOf(key.keyCreatedAt), wakeSecretEnc: key.wakeSecretEnc }).where(eq(assistants.personId, key.personId));
    }
  });
}

/* The nodes' keys as they were when the old database closed: a node that signed out, was taken back or joined again with
   a new key since opens nothing with the bundle's key, and the key that opened it then works on. A node that lost its key
   signs in again, and the plans of the nodes whose keys were set are settled as when a node signs out. A node made since
   is not in the restored database, nor is its key. */
async function carryNodeKeys(db: Db, carry: Carry): Promise<void> {
  const keys = carry.nodeKeys;
  if (!keys) return;
  const keeps = new Set(keys.map(key => key.id));
  await db.transaction(async tx => {
    const had = await tx.update(nodes).set({ keyHash: null }).where(liveNode).returning({ id: nodes.id, subscriptionId: nodes.subscriptionId });
    const lost = had.filter(node => !keeps.has(node.id));
    if (lost.length > 0) await tx.update(nodes).set({ status: 'needs_login' }).where(inArray(nodes.id, lost.map(node => node.id)));
    const given: { subscriptionId: string | null }[] = [];
    for (const key of keys) given.push(...await tx.update(nodes).set({ keyHash: key.keyHash }).where(eq(nodes.id, key.id)).returning({ subscriptionId: nodes.subscriptionId }));
    await settlePlans(tx, [...lost, ...given].map(node => node.subscriptionId));
  });
}

/* What a restore to that time undoes: the machines that joined and the people who were added since are not in it. */
export async function warningOf(db: Db, dumpedAt: Date): Promise<{ machines: { name: string; owner: string }[]; people: string[] }> {
  const joined = await db
    .select({ name: machines.hostname, owner: people.name })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), gt(machines.createdAt, dumpedAt)))
    .orderBy(machines.createdAt);
  const added = await db.select(only(people, 'name')).from(people).where(gt(people.createdAt, dumpedAt)).orderBy(people.createdAt);
  return { machines: joined, people: added.map(person => person.name) };
}

const refused = (reason: ErrorReason, message: string) => new ApiError(409, 'conflict', message, reason);
const LINES: Record<NotRestorable, string> = {
  newer_build: 'This backup was made by a newer Hornhoof. Update first.',
  not_held: 'No machine that is online holds this backup now.',
  needs_recovery_file: 'This server cannot open this backup. Add the recovery file it was made for.',
};

/* The app's part of a restore from a backup, while it leads: it checks that the bundle can be restored here, gives its
   own keeper the order, and after the databases were swapped puts who may get in now into the restored one before it
   serves anybody. A restore and an update share one claim on the updater, so only one of them is ever out. An order
   lives in memory alone, and with it the recovery identity it may carry: an app that restarts lets go of it. */
export class Restores {
  private current: { order: RestoreOrder; at: number; from: string | null } | null = null;
  private applied = false;
  /* Whether this app started with something carried over that it has not dealt with: the updater writes that while
     the app is down, so one look at the start tells. */
  private carried: boolean;

  constructor(private readonly ctx: Ctx) {
    this.carried = existsSync(join(ctx.config.controlDir, RESTORE_CARRY));
  }

  /* Why this bundle cannot be restored here now, or who holds it: this server itself (null) or the machine to ask. */
  private async held(row: BackupRow): Promise<{ from: string | null } | NotRestorable> {
    const { db, config } = this.ctx;
    if (row.migrations > knownMigrations()) return 'newer_build';
    const mine = await findThisMachine(db, config);
    const holding = await db.select({ id: machines.id, reportAt: machines.reportAt }).from(machines).where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), sql`${row.id}::uuid = ANY(${machines.heldBackups})`));
    if (mine && holding.some(machine => machine.id === mine.id)) return { from: null };
    const online = holding.filter(machine => machine.reportAt && Date.now() - machine.reportAt.getTime() < ONLINE_MS).sort((a, b) => b.reportAt!.getTime() - a.reportAt!.getTime());
    return online[0] ? { from: online[0].id } : 'not_held';
  }

  private async opens(row: BackupRow): Promise<boolean> {
    const { db, config } = this.ctx;
    if (!config.machineId) return false;
    const [mine] = await db.select(only(machines, 'ageKey')).from(machines).where(and(eq(machines.networkId, config.machineId), isNull(machines.revokedAt)));
    return Boolean(mine?.ageKey && row.recipients.includes(mine.ageKey));
  }

  /* Whether the CEO could restore this bundle now without a recovery file, and why not. */
  async restorable(row: BackupRow): Promise<NotRestorable | null> {
    const held = await this.held(row);
    if (typeof held === 'string') return held;
    return (await this.opens(row)) ? null : 'needs_recovery_file';
  }

  /* Takes the claim first, before anything is asked of the database, so a restore and an update asked at once never
     both go on; every refusal after that frees it. bringBack: whether what came after the bundle comes back from the
     database the restore sets aside; it is written down before the order goes, as this app's memory does not outlive
     the swap. Answers the attempt. */
  async start(me: Person, id: string, recoveryText?: string, bringBack = true): Promise<string> {
    const { db, config } = this.ctx;
    this.order();
    if (!this.ctx.updater.present()) throw new ApiError(503, 'unavailable', 'The updater is not running, so nothing can be restored now.', 'updater_missing');
    const attempt = randomUUID();
    if (this.ctx.updater.claim('restore', attempt)) throw refused('restore_busy', 'A restore or an update is running.');
    try {
      if (this.ctx.mode.current() !== 'lead') throw new ApiError(503, 'unavailable', 'This server does not lead the company now.');
      const row = await bundleRow(db, id);
      if (!row || row.company !== me.companyId) throw new ApiError(404, 'not_found', 'There is no such backup.');
      const held = await this.held(row);
      if (typeof held === 'string') throw refused(held, LINES[held]);
      const identity = await this.identityFor(row, recoveryText);
      const authority = await authorityOf(db, config);
      if (!authority) throw refused('no_authority', 'The company has no certificate authority yet.');
      const order: RestoreOrder = {
        attempt, id: row.id, dumpedAt: row.dumpedAt, source: 'store', identity, expect: { sha256: row.sha256, size: row.size, signer: row.signer },
        company: row.company, authorityPem: authority.certPem, carry: true,
      };
      writeChoice(config.controlDir, { attempt, bringBack });
      this.current = { order, at: Date.now(), from: held.from };
      return attempt;
    } catch (err) {
      this.ctx.updater.free(attempt);
      throw err;
    }
  }

  /* After a total loss: a bundle that was sent to this server, restored with the recovery file it was given. There is
     no database to check the bundle against, and none to carry anything over from. Answers the attempt. */
  startIncoming(file: RecoveryFile, manifest: Manifest): string {
    this.order();
    if (!this.ctx.updater.present()) throw new ApiError(503, 'unavailable', 'The updater is not running, so nothing can be restored now.', 'updater_missing');
    if (this.ctx.mode.current() !== 'lead') throw new ApiError(503, 'unavailable', 'This server does not lead the company now.');
    if (manifest.migrations > knownMigrations()) throw refused('newer_build', LINES.newer_build);
    const attempt = randomUUID();
    if (this.ctx.updater.claim('restore', attempt)) throw refused('restore_busy', 'A restore or an update is running.');
    const order: RestoreOrder = { attempt, id: manifest.id, dumpedAt: manifest.dumpedAt, source: 'incoming', identity: file.identity, expect: null, company: file.company, authorityPem: file.authorityPem, carry: false };
    this.current = { order, at: Date.now(), from: null };
    return attempt;
  }

  /* The recovery identity the order carries: none when this server's own key opens the bundle, else the one of the file
     the CEO added, which must be the very file the bundle was sealed for. */
  private async identityFor(row: BackupRow, recoveryText?: string): Promise<string | null> {
    if (recoveryText === undefined) {
      if (await this.opens(row)) return null;
      throw refused('needs_recovery_file', LINES.needs_recovery_file);
    }
    const file = await parseRecoveryFile(recoveryText);
    if (file.recipient !== row.recovery || file.company !== row.company) throw refused('needs_recovery_file', LINES.needs_recovery_file);
    return file.identity;
  }

  /* The order that is out: younger than an hour, and not ended by its keeper or its updater. One that ended, or ran out
     of time, is let go here, and the claim on the updater with it. */
  order(): RestoreOrder | null {
    const current = this.current;
    if (!current) return null;
    const status = readRestoreStatus(this.ctx.config.controlDir);
    const ended = status?.attempt === current.order.attempt && status.state !== 'running';
    if (!ended && Date.now() - current.at < ORDER_MS) return current.order;
    this.current = null;
    this.ctx.updater.free(current.order.attempt);
    return null;
  }

  /* The holder asked to send the order's bundle, while this server does not hold it itself. */
  async wanted(): Promise<{ id: string; from: string }[]> {
    const order = this.order();
    const from = this.current?.from;
    if (!order || !from) return [];
    const mine = await findThisMachine(this.ctx.db, this.ctx.config);
    const [here] = mine ? await this.ctx.db.select(idOnly(machines)).from(machines).where(and(eq(machines.id, mine.id), sql`${order.id}::uuid = ANY(${machines.heldBackups})`)) : [];
    return here ? [] : [{ id: order.id, from }];
  }

  /* What a person is shown. An order its keeper has not said a word of yet runs at its first step, whatever the
     attempt before left. A status at one of the keeper's steps counts as running only while its order is out: a
     keeper whose app restarted calls the restore off itself within a round. */
  status(): RestoreStatus | null {
    const status = readRestoreStatus(this.ctx.config.controlDir);
    const order = this.order();
    if (order && this.current && status?.attempt !== order.attempt) {
      return { attempt: order.attempt, id: order.id, state: 'running', step: 'fetch', line: '', at: new Date(this.current.at).toISOString(), kept: null };
    }
    if (!status || status.state !== 'running' || !KEEPER_STEPS.includes(status.step)) return status;
    return order?.attempt === status.attempt ? status : { ...status, state: 'failed', line: CALLED_OFF };
  }

  /* Whether the restored database, if this is one, has taken over who may get in now: before that nobody is served. */
  ready(): boolean {
    return this.applied;
  }

  /* Whether nobody is served in this mode yet: a leader until it has looked at what was carried over, and an app in
     any other mode while what was carried over still waits for it to lead. */
  holds(mode: Mode): boolean {
    return !this.applied && (mode === 'lead' || this.carried);
  }

  /* At the app's first lead after its start. When the databases were swapped for good, which the status says with the
     step start or with done, what the updater carried over from the old one is applied and the file goes; a carry of
     another attempt, or of a restore that failed, goes unapplied. It throws when it cannot tell or cannot apply, and is
     tried again. */
  async afterSwap(): Promise<void> {
    const dir = this.ctx.config.controlDir;
    const carried = controlJson<{ attempt?: unknown; carry?: Carry }>(dir, RESTORE_CARRY);
    const status = carried ? controlJson<RestoreStatus>(dir, RESTORE_STATUS) : readRestoreStatus(dir);
    const swapped = status !== null && (status.state === 'done' || (status.state === 'running' && status.step === 'start'));
    if (carried) {
      if (swapped && status.attempt === carried.attempt && carried.carry) await applyCarry(this.ctx, carried.carry);
      rmSync(join(dir, RESTORE_CARRY), { force: true });
    }
    if (swapped) await this.mark(status);
    this.carried = false;
    this.applied = true;
    /* The database the restore set aside is found once its updater has said which one it is. */
    await this.ctx.merger.discover().catch((err: unknown) => this.ctx.log.warn({ error: loggable(err) }, 'Could not look for the database the restore kept. It is looked for again in a minute.'));
  }

  /* The mark a restore leaves in the database it restored, once per attempt: from which bundle and from when it is.
     The order is gone by now and the restored database rarely holds its own bundle's record, so the updater's status
     says it. A source that lacks this restore is compared row by row, as its journal proves nothing of these rows. An
     updater from before merges says no time of the dump: its restore is marked all the same, with the time its status
     was written, since what waited to go outside is told from what was written since by the mark alone. */
  private async mark(status: RestoreStatus): Promise<void> {
    await this.ctx.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (${status.attempt}, ${status.id}, ${status.dumpedAt ?? status.at}::timestamptz, ${status.kept}) ON CONFLICT (attempt) DO NOTHING`);
  }
}
