import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { certificates, companies, machines, people, recoveryKeys } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { notAMachine } from '../network/join.js';
import { authorityOf, findThisMachine, networkMachine } from '../network/store.js';
import { keeperAsker } from '../network/via.js';
import { BundleRefused, checkHead, MAX_HEAD, type Manifest } from './bundle.js';
import { namedBundles, pickHolders } from './holders.js';
import { activeRecovery, makeRecoveryFile } from './recovery.js';
import { bundleRow, bundleRows, recordBundle } from './records.js';
import { forkWanted } from '../merge/merger.js';
import { KEPT_NAME } from '../merge/source.js';
import { warningOf } from './restore.js';
import { FORK_KEEP_MS, type HolderView, type MakerView } from './types.js';

/* A bundle is recorded only while it is new: one made longer ago than this is some old file sent again. */
const RECORD_WITHIN_MS = 24 * 3_600_000;
/* How many bundles of the database in use the CEO's list shows. */
const LISTED = 10;
/* A machine that reported within this is online, as its card says. */
const ONLINE_MS = 2 * 60_000;

/* from: the machine the server's own keeper took the bundle from, when it is not its own: a machine that holds the
   data and led before gives what its database held. */
const RecordBody = z.object({ head: z.string().min(2).max(MAX_HEAD), from: z.uuid().optional() });
const ViewQuery = z.object({ as: z.literal('maker').optional() });
const BundleParams = z.object({ id: z.uuid() });
/* A recovery file is a comment line and one line of JSON. */
const MAX_RECOVERY_FILE = 16 * 1024;
const RestoreBody = z.object({ recoveryFile: z.string().min(1).max(MAX_RECOVERY_FILE).optional(), bringBack: z.boolean().optional() });
const KeptParams = z.object({ name: z.string().regex(KEPT_NAME) });
/* The stamp in the name of a database a restore kept, as the updater writes it. */
const KEPT_STAMP = /^hornhoof_before_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;
type KeptMerge = { id: string; status: 'pending' | 'applied' | 'merged' | 'removing' | 'done'; added: number; conflicts: number; error: string | null };

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const notCeo = () => new ApiError(403, 'forbidden', 'Only the CEO does this, by himself or through the orchestrator.', 'not_owner_session');

/* Backups as the app keeps them: it records the bundles its own keeper made, picks the machines that keep each, tells
   every keeper what to seal to or what to hold, and gives the CEO the recovery file and the list. It never holds a
   bundle or a private key itself. */
export function backupRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const leads = () => {
    if (ctx.mode.current() !== 'lead') throw new ApiError(503, 'unavailable', 'This server does not lead the company now.');
  };

  /* The company's CEO, by himself or through the orchestrator, and nobody else. */
  function ceo(me: Person): Person {
    if (!me.isOwner || me.viaHead) throw notCeo();
    return me;
  }
  /* Who is not a keeper gets no further. */
  const requireKeeper = async (req: FastifyRequest) => {
    const who = await keeperAsker(req, config);
    if (!who) throw notKeeper();
    return who;
  };

  /* What the server's own keeper hears: whom to seal to and what was made, with who holds it. */
  async function makerView(): Promise<MakerView> {
    const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
    const data = await db.select(only(machines, 'ageKey')).from(machines).where(and(isNull(machines.revokedAt), eq(machines.role, 'data'), isNotNull(machines.ageKey)));
    const recovery = company ? await activeRecovery(db, config) : null;
    /* The last backup of the database in use as it is now: a database set aside before a merge is none of it, and
       neither is a backup made before the company was last restored, whose record a merge may have brought back. */
    const [last] = await bundleRows(db, { limit: 1, forks: 'none', sinceRestore: true });
    const held = await namedBundles(db);
    return {
      company: company?.id ?? null,
      recipients: [...new Set(data.map(row => row.ageKey!))].sort(),
      recovery: recovery ? { id: recovery.id, recipient: recovery.recipient, link: recovery.link } : null,
      last: last ? { id: last.id, madeAt: last.madeAt, recovery: last.recovery } : null,
      holders: Object.fromEntries(held.map(row => [row.id, row.holders])),
      wanted: await ctx.restores.wanted(),
      order: ctx.restores.order(),
      fork: await forkWanted(db),
    };
  }

  /* What a machine that may keep bundles hears: its owner's tick, and the newest bundles it was picked for. */
  async function holderView(machineId: string): Promise<HolderView> {
    const row = await networkMachine(db, machineId);
    if (!row) throw notAMachine();
    const held = await namedBundles(db);
    const want = (await ctx.restores.wanted()).filter(wanted => wanted.from === machineId).map(wanted => wanted.id);
    return { keeps: row.keepsBackups, hold: held.filter(bundle => bundle.holders.includes(machineId)).map(({ id, size, sha256 }) => ({ id, size, sha256 })), want };
  }

  /* The databases a restore replaced and kept on this machine, newest first, each with how far the bringing back of
     what it holds has got. One that was brought back or left out and removed is listed no more. */
  async function keptDatabases(): Promise<{ name: string; at: string; merge: KeptMerge | null }[]> {
    const found = rowsOf<{ name: string }>(await db.execute(sql`SELECT datname AS name FROM pg_database WHERE datname LIKE 'hornhoof_before_%'`)).map(row => row.name);
    const merges = rowsOf<{ id: string; source: string; status: KeptMerge['status']; counts: { added?: number; conflicts?: number }; error: string | null }>(
      await db.execute(sql`SELECT id, source, status, counts, error FROM net.merges WHERE source LIKE 'kept:%'`),
    );
    const bySource = new Map(merges.map(merge => [merge.source.slice(5), merge]));
    const names = new Set([...found, ...merges.filter(merge => merge.status !== 'done').map(merge => merge.source.slice(5))]);
    return [...names].sort().reverse().flatMap(name => {
      const stamp = KEPT_STAMP.exec(name);
      const merge = bySource.get(name);
      const shown = merge ? { id: merge.id, status: merge.status, added: merge.counts.added ?? 0, conflicts: merge.counts.conflicts ?? 0, error: merge.error } : null;
      return stamp ? [{ name, at: `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`, merge: shown }] : [];
    });
  }

  /* A fork another machine sealed of its own database. True when it was recorded now, false when it was there. */
  async function recordFrom(from: string, mine: string | null, head: string, manifest: Manifest): Promise<boolean> {
    if (manifest.reason !== 'fork') throw new ApiError(400, 'validation', 'Only the bundle of a database that led is recorded for another machine.', 'bundle_refused');
    const row = await networkMachine(db, from);
    const [certificate] = await db.select(only(certificates, 'serial')).from(certificates).where(and(eq(certificates.serial, manifest.serial), eq(certificates.machineId, from), isNull(certificates.revokedAt)));
    if (!row || row.role !== 'data' || from === mine || manifest.signer !== from || !certificate) throw new ApiError(403, 'forbidden', 'This bundle was not signed by that machine with a certificate that stands.');
    if (Math.abs(Date.now() - Date.parse(manifest.madeAt)) > RECORD_WITHIN_MS) throw new ApiError(400, 'validation', 'This bundle was not made today.', 'bundle_time');
    if (await bundleRow(db, manifest.id)) return false;
    const holders = manifest.recovery ? await pickHolders(db, { size: manifest.size, keep: [] }) : [];
    return recordBundle(db, { ...manifest, head, holders });
  }

  /* The answer to the server's own keeper may carry a recovery identity, which lives in memory alone: this route logs
     neither the request nor the answer. */
  app.get('/api/network/backups', { logLevel: 'silent' }, async req => {
    const who = await requireKeeper(req);
    leads();
    if (who.own) return makerView();
    /* The keeper of another machine that holds the data seals what its own database held while it led: it hears whom
       the company's backups are sealed to, and nothing of what the leader's keeper alone acts on. */
    if (ViewQuery.safeParse(req.query).data?.as === 'maker' && (await networkMachine(db, who.machine))?.role === 'data') {
      const { company, recipients, recovery } = await makerView();
      return { company, recipients, recovery, last: null, holders: {}, wanted: [], order: null, fork: null } satisfies MakerView;
    }
    return holderView(who.machine);
  });

  /* The server's own keeper records a bundle it made. Its head must hold against the company's authority, and its signer
     must be this very machine, with a certificate of it that still stands: no worker records a bundle, and a restore
     later checks a bundle against this record. The one bundle it records for another machine is a fork that a machine
     which holds the data sealed of its own database: the keeper says whom it took it from, and the signer must be that
     very machine, live, with a certificate that stands. */
  app.post('/api/network/backups', { bodyLimit: MAX_HEAD + 1024 }, async (req, reply) => {
    const who = await requireKeeper(req);
    if (!who.own) throw notKeeper();
    leads();
    const { head, from } = RecordBody.parse(req.body);
    const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
    const authority = await authorityOf(db, config);
    if (!company || !authority) throw new ApiError(409, 'conflict', 'The company has no certificate authority yet.', 'no_authority');
    let manifest;
    try {
      manifest = checkHead(head, { authorityPem: authority.certPem, company: company.id });
    } catch (err) {
      if (!(err instanceof BundleRefused)) throw err;
      throw new ApiError(400, 'validation', err.message, `bundle_${err.reason}`);
    }
    const mine = await findThisMachine(db, config);
    if (from !== undefined) return reply.code((await recordFrom(from, mine?.id ?? null, head, manifest)) ? 201 : 200).send({ holders: (await bundleRow(db, manifest.id))?.holders ?? [] });
    const [certificate] = mine ? await db.select(only(certificates, 'serial')).from(certificates).where(and(eq(certificates.serial, manifest.serial), eq(certificates.machineId, mine.id), isNull(certificates.revokedAt))) : [];
    if (!mine || manifest.signer !== mine.id || !certificate) throw new ApiError(403, 'forbidden', "This bundle was not signed by this server's own machine with a certificate that stands.");
    if (Math.abs(Date.now() - Date.parse(manifest.madeAt)) > RECORD_WITHIN_MS) throw new ApiError(400, 'validation', 'This bundle was not made today.', 'bundle_time');
    const known = await bundleRow(db, manifest.id);
    if (known) return reply.code(200).send({ holders: known.holders });
    /* A fork is the bundle of a database the company set aside, under the id its merge gave it, and of nothing else. */
    if (manifest.reason === 'fork' && rowsOf(await db.execute(sql`SELECT 1 FROM net.merges WHERE fork = ${manifest.id}`)).length === 0) {
      throw new ApiError(400, 'validation', 'This bundle is of no database the company set aside.', 'bundle_refused');
    }
    /* A bundle no recovery file opens stays on the data machine: nobody could open a copy once that machine is lost. */
    const holders = manifest.recovery ? await pickHolders(db, { size: manifest.size, keep: [] }) : [];
    const made = await recordBundle(db, { ...manifest, head, holders });
    return reply.code(made ? 201 : 200).send({ holders: made ? holders : ((await bundleRow(db, manifest.id))?.holders ?? []) });
  });

  /* The recovery file, answered once and kept nowhere. */
  app.post('/api/backups/recovery', async (req, reply) => {
    const me = ceo(await requirePerson(req, db));
    leads();
    const file = await makeRecoveryFile(db, config, me);
    return reply.header('cache-control', 'no-store').send(file);
  });

  /* Whether the company has a recovery file that opens its backups, for the line the CEO is shown on every screen. */
  app.get('/api/backups/recovery', async req => {
    const me = ceo(await requirePerson(req, db));
    const active = await activeRecovery(db, config);
    const [newest] = active ? [] : await db.select(idOnly(recoveryKeys)).from(recoveryKeys).where(and(eq(recoveryKeys.companyId, me.companyId), isNull(recoveryKeys.retiredAt))).limit(1);
    /* A key that is not retired and is not the company's now was saved with another link. */
    return { recoveryNeeded: !active, linkChanged: Boolean(newest) };
  });

  /* The bundles and where each is held, for the CEO. */
  app.get('/api/backups', async req => {
    const me = ceo(await requirePerson(req, db));
    /* The newest of the database in use, and beside them every database set aside before a merge while it is kept. */
    const rows = await bundleRows(db, { limit: LISTED, forks: 'none' });
    const forks = await bundleRows(db, { forks: { since: new Date(Date.now() - FORK_KEEP_MS) } });
    const active = await activeRecovery(db, config);
    const [newest] = await db.select(idOnly(recoveryKeys)).from(recoveryKeys).where(and(eq(recoveryKeys.companyId, me.companyId), isNull(recoveryKeys.retiredAt))).limit(1);
    const [maker] = active ? await db.select(only(people, 'name')).from(people).where(eq(people.id, active.madeBy)) : [];
    const cored = await db.select().from(machines).where(and(eq(machines.companyId, me.companyId), isNull(machines.revokedAt), isNotNull(machines.networkId)));
    const own = await findThisMachine(db, config);
    const online = (reportAt: Date | null) => reportAt !== null && Date.now() - reportAt.getTime() < ONLINE_MS;
    const bundles = await Promise.all([...rows, ...forks].map(async row => ({ row, why: await ctx.restores.restorable(row) })));
    const where = (id: string) =>
      cored
        .filter(machine => machine.heldBackups.includes(id))
        .map(machine => (machine.id === own?.id ? { machine: null, name: 'this server', online: true } : { machine: machine.id, name: machine.hostname, online: online(machine.reportAt) }))
        .sort((a, b) => Number(a.machine !== null) - Number(b.machine !== null) || a.name.localeCompare(b.name));
    /* The last backup of the company as it is now: one made before it was last restored is none. */
    const [last] = await bundleRows(db, { limit: 1, forks: 'none', sinceRestore: true });
    return {
      last: last?.madeAt ?? null,
      recovery: active ? { madeAt: active.madeAt.toISOString(), madeBy: maker?.name ?? '' } : null,
      recoveryNeeded: !active,
      /* A key that is not retired and is not the company's now was saved with another link. */
      linkChanged: Boolean(newest) && !active,
      restore: ctx.restores.status(),
      kept: await keptDatabases(),
      bundles: bundles.map(({ row, why }) => ({
        id: row.id, dumpedAt: row.dumpedAt, reason: row.reason, size: row.size, recovery: row.recovery === null ? 'none' : row.recovery === active?.recipient ? 'current' : 'older', where: where(row.id),
        restorable: why === null || why === 'needs_recovery_file', why,
      })),
    };
  });

  /* What a restore of this bundle undoes, for the CEO to read before it starts. */
  app.get('/api/backups/:id/warning', async req => {
    const me = ceo(await requirePerson(req, db));
    const row = await bundleRow(db, BundleParams.parse(req.params).id);
    if (!row || row.company !== me.companyId) throw new ApiError(404, 'not_found', 'There is no such backup.');
    return warningOf(db, new Date(row.dumpedAt));
  });

  /* The CEO restores the company from a bundle. The recovery file, when one is added, is kept in memory for the hour
     the order lives, and is never logged. */
  app.post('/api/backups/:id/restore', { bodyLimit: MAX_RECOVERY_FILE + 1024, logLevel: 'silent' }, async (req, reply) => {
    const me = ceo(await requirePerson(req, db));
    const { id } = BundleParams.parse(req.params);
    const { recoveryFile, bringBack } = RestoreBody.parse(req.body ?? {});
    return reply.code(202).send({ attempt: await ctx.restores.start(me, id, recoveryFile, bringBack ?? true) });
  });

  /* The CEO leaves out what a database a restore kept holds: it is saved as a backup and removed, with nothing of it
     brought back. Only while its bringing back still waits or runs. */
  app.post('/api/backups/kept/:name/leave', async (req, reply) => {
    ceo(await requirePerson(req, db));
    leads();
    const { name } = KeptParams.parse(req.params);
    const left = rowsOf(await db.execute(sql`UPDATE net.merges SET status = 'removing' WHERE source = ${`kept:${name}`} AND status IN ('pending', 'applied') RETURNING id`));
    if (left.length === 0) throw new ApiError(409, 'conflict', 'Nothing of this database is being brought back now.', 'not_pending');
    return reply.code(204).send();
  });
}
