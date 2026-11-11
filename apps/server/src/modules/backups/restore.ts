import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { MIGRATIONS } from '../../db/client.js';
import { certificates, companies, computerRuns, departments, invites, machineAccess, machines, people, personAccess, recoveryKeys, sessions, teams } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { authorityOf, findThisMachine } from '../network/store.js';
import { disconnectMachines } from '../nodes/disconnect.js';
import { disablePerson } from '../people/routes.js';
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

export type NotRestorable = 'newer_build' | 'not_held' | 'needs_recovery_file';

/* How many migrations this build knows: a backup of a database with more was made by a newer one. */
export function knownMigrations(): number {
  return (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;
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
   who was disabled since, a password that was changed, a machine that was disconnected or a recovery file that was
   replaced. Each part touches only what this database has. Then computer access closes everywhere and every session
   ends, so each owner opens their machine again and everyone signs in again. */
export async function applyCarry(ctx: Ctx, carry: Carry): Promise<void> {
  const { db } = ctx;
  const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!company) return;
  const here = await db.select({ id: people.id, status: people.status }).from(people);
  const known = new Map(here.map(person => [person.id, person.status]));
  const [placesD, placesT] = [new Set((await db.select({ id: departments.id }).from(departments)).map(row => row.id)), new Set((await db.select({ id: teams.id }).from(teams)).map(row => row.id))];
  /* Who stopped being the owner first, so the company never has two. */
  const theirs = carry.people.filter(person => known.has(person.id)).sort((a, b) => Number(a.isOwner) - Number(b.isOwner));
  for (const person of theirs) {
    if (person.status === 'disabled') {
      if (known.get(person.id) !== 'disabled') await disablePerson(ctx, person.id);
      continue;
    }
    await db.transaction(async tx => {
      await tx.update(people).set({ status: person.status, passwordHash: person.passwordHash, scopeKind: person.scopeKind as Person['scopeKind'], isOwner: person.isOwner }).where(eq(people.id, person.id));
      await tx.delete(personAccess).where(eq(personAccess.personId, person.id));
      const rows = person.access
        .filter(place => (place.departmentId === null || placesD.has(place.departmentId)) && (place.teamId === null || placesT.has(place.teamId)))
        .map(place => ({ companyId: company.id, personId: person.id, departmentId: place.departmentId, teamId: place.teamId }));
      if (rows.length > 0) await tx.insert(personAccess).values(rows);
    });
  }
  /* An invite that was used or called off since is not open again. */
  await db.delete(invites).where(and(isNull(invites.usedAt), carry.invites.length > 0 ? notInArray(invites.tokenHash, carry.invites) : undefined));
  const live = new Set((await db.select({ id: machines.id }).from(machines).where(isNull(machines.revokedAt))).map(row => row.id));
  await disconnectMachines(ctx, carry.machines.filter(machine => machine.revoked && live.has(machine.id)).map(machine => machine.id));
  for (const machine of carry.machines) await db.update(machines).set({ lendsTests: machine.lendsTests, keepsBackups: machine.keepsBackups }).where(eq(machines.id, machine.id));
  const now = new Date();
  if (carry.serials.length > 0) await db.update(certificates).set({ revokedAt: now }).where(and(inArray(certificates.serial, carry.serials), isNull(certificates.revokedAt)));
  await carryRecoveryKeys(db, company.id, carry, known, now);
  await db.transaction(async tx => {
    await tx.update(machineAccess).set({ until: null, grant: null, openedBy: null, openedAt: null, askedReason: null, askedAt: null });
    await tx.update(computerRuns).set({ state: 'lost' }).where(inArray(computerRuns.state, ['waiting', 'sent']));
    await tx.delete(sessions);
  });
  ctx.bus.accessChanged(company.id);
  ctx.bus.publish(company.id, { type: 'org' });
  ctx.bus.publish(company.id, { type: 'computer' });
}

/* The recovery keys as they were when the old database closed: its rows by their ids, and every other one retired. */
async function carryRecoveryKeys(db: Db, companyId: string, carry: Carry, known: Map<string, string>, now: Date): Promise<void> {
  const [owner] = await db.select({ id: people.id }).from(people).where(eq(people.isOwner, true)).limit(1);
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

/* What a restore to that time undoes: the machines that joined and the people who were added since are not in it. */
export async function warningOf(db: Db, dumpedAt: Date): Promise<{ machines: { name: string; owner: string }[]; people: string[] }> {
  const joined = await db
    .select({ name: machines.hostname, owner: people.name })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), gt(machines.createdAt, dumpedAt)))
    .orderBy(machines.createdAt);
  const added = await db.select({ name: people.name }).from(people).where(gt(people.createdAt, dumpedAt)).orderBy(people.createdAt);
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

  constructor(private readonly ctx: Ctx) {}

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
    const [mine] = await db.select({ ageKey: machines.ageKey }).from(machines).where(and(eq(machines.networkId, config.machineId), isNull(machines.revokedAt)));
    return Boolean(mine?.ageKey && row.recipients.includes(mine.ageKey));
  }

  /* Whether the CEO could restore this bundle now without a recovery file, and why not. */
  async restorable(row: BackupRow): Promise<NotRestorable | null> {
    const held = await this.held(row);
    if (typeof held === 'string') return held;
    return (await this.opens(row)) ? null : 'needs_recovery_file';
  }

  /* Takes the claim first, before anything is asked of the database, so a restore and an update asked at once never
     both go on; every refusal after that frees it. Answers the attempt. */
  async start(me: Person, id: string, recoveryText?: string): Promise<string> {
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
    const [here] = mine ? await this.ctx.db.select({ id: machines.id }).from(machines).where(and(eq(machines.id, mine.id), sql`${order.id}::uuid = ANY(${machines.heldBackups})`)) : [];
    return here ? [] : [{ id: order.id, from }];
  }

  /* What a person is shown. A status at one of the keeper's steps counts as running only while its order is out: a
     keeper whose app restarted calls the restore off itself within a round. */
  status(): RestoreStatus | null {
    const status = readRestoreStatus(this.ctx.config.controlDir);
    if (!status || status.state !== 'running' || !KEEPER_STEPS.includes(status.step)) return status;
    return this.order()?.attempt === status.attempt ? status : { ...status, state: 'failed', line: CALLED_OFF };
  }

  /* Whether the restored database, if this is one, has taken over who may get in now: before that nobody is served. */
  ready(): boolean {
    return this.applied;
  }

  /* At the app's first lead after its start. When the databases were swapped for good, which the status says with the
     step start or with done, what the updater carried over from the old one is applied and the file goes; a carry of
     another attempt, or of a restore that failed, goes unapplied. It throws when it cannot tell or cannot apply, and is
     tried again. */
  async afterSwap(): Promise<void> {
    const dir = this.ctx.config.controlDir;
    const carried = controlJson<{ attempt?: unknown; carry?: Carry }>(dir, RESTORE_CARRY);
    if (carried) {
      const status = controlJson<RestoreStatus>(dir, RESTORE_STATUS);
      const swapped = status !== null && status.attempt === carried.attempt && (status.state === 'done' || (status.state === 'running' && status.step === 'start'));
      if (swapped && carried.carry) await applyCarry(this.ctx, carried.carry);
      rmSync(join(dir, RESTORE_CARRY), { force: true });
    }
    this.applied = true;
  }
}
