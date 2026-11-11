import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { certificates, companies, machines, people, recoveryKeys } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { notAMachine } from '../network/join.js';
import { authorityOf, findThisMachine, networkMachine } from '../network/store.js';
import { keeperAsker } from '../network/via.js';
import { BundleRefused, checkHead, MAX_HEAD } from './bundle.js';
import { pickHolders } from './holders.js';
import { activeRecovery, linkChanged, makeRecoveryFile } from './recovery.js';
import { bundleRow, bundleRows, recordBundle } from './records.js';
import type { HolderView, MakerView } from './types.js';

/* A bundle is recorded only while it is new: one made longer ago than this is some old file sent again. */
const RECORD_WITHIN_MS = 24 * 3_600_000;
/* How many bundles the CEO's list shows, and of how many the holders are told. */
const LISTED = 10;
const HELD_NEWEST = 2;
/* A machine that reported within this is online, as its card says. */
const ONLINE_MS = 2 * 60_000;

const RecordBody = z.object({ head: z.string().min(2).max(MAX_HEAD) });

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const notCeo = () => new ApiError(403, 'forbidden', 'Only the CEO does this, from his own session.', 'not_owner_session');

/* Backups as the app keeps them: it records the bundles its own keeper made, picks the machines that keep each, tells
   every keeper what to seal to or what to hold, and gives the CEO the recovery file and the list. It never holds a
   bundle or a private key itself. */
export function backupRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const leads = () => {
    if (ctx.mode.current() !== 'lead') throw new ApiError(503, 'unavailable', 'This server does not lead the company now.');
  };

  /* The company's CEO on their own session: never the orchestrator acting for them, and nobody else. */
  function ceo(me: Person): Person {
    if (!me.isOwner || me.via) throw notCeo();
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
    const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
    const data = await db.select({ ageKey: machines.ageKey }).from(machines).where(and(isNull(machines.revokedAt), eq(machines.role, 'data'), isNotNull(machines.ageKey)));
    const recovery = company ? await activeRecovery(db, config) : null;
    const [last] = await bundleRows(db, { limit: 1 });
    const held = await bundleRows(db, { limit: HELD_NEWEST, withRecovery: true });
    return {
      company: company?.id ?? null,
      recipients: [...new Set(data.map(row => row.ageKey!))].sort(),
      recovery: recovery ? { id: recovery.id, recipient: recovery.recipient, link: recovery.link } : null,
      last: last ? { id: last.id, madeAt: last.madeAt, recovery: last.recovery } : null,
      holders: Object.fromEntries(held.map(row => [row.id, row.holders])),
      wanted: [],
      order: null,
    };
  }

  /* What a machine that may keep bundles hears: its owner's tick, and the newest bundles it was picked for. */
  async function holderView(machineId: string): Promise<HolderView> {
    const row = await networkMachine(db, machineId);
    if (!row) throw notAMachine();
    const held = await bundleRows(db, { limit: HELD_NEWEST, withRecovery: true });
    return { keeps: row.keepsBackups, hold: held.filter(bundle => bundle.holders.includes(machineId)).map(({ id, size, sha256 }) => ({ id, size, sha256 })), want: [] };
  }

  app.get('/api/network/backups', async req => {
    const who = await requireKeeper(req);
    leads();
    return who.own ? makerView() : holderView(who.machine);
  });

  /* The server's own keeper records a bundle it made. Its head must hold against the company's authority, and its signer
     must be this very machine, with a certificate of it that still stands: no worker records a bundle, and a restore
     later checks a bundle against this record. */
  app.post('/api/network/backups', { bodyLimit: MAX_HEAD + 1024 }, async (req, reply) => {
    const who = await requireKeeper(req);
    if (!who.own) throw notKeeper();
    leads();
    const { head } = RecordBody.parse(req.body);
    const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
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
    const [certificate] = mine ? await db.select({ serial: certificates.serial }).from(certificates).where(and(eq(certificates.serial, manifest.serial), eq(certificates.machineId, mine.id), isNull(certificates.revokedAt))) : [];
    if (!mine || manifest.signer !== mine.id || !certificate) throw new ApiError(403, 'forbidden', "This bundle was not signed by this server's own machine with a certificate that stands.");
    if (Math.abs(Date.now() - Date.parse(manifest.madeAt)) > RECORD_WITHIN_MS) throw new ApiError(400, 'validation', 'This bundle was not made today.', 'bundle_time');
    const known = await bundleRow(db, manifest.id);
    if (known) return reply.code(200).send({ holders: known.holders });
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

  /* The bundles and where each is held, for the CEO. */
  app.get('/api/backups', async req => {
    const me = ceo(await requirePerson(req, db));
    const rows = await bundleRows(db, { limit: LISTED });
    const active = await activeRecovery(db, config);
    const [newest] = await db.select({ id: recoveryKeys.id }).from(recoveryKeys).where(and(eq(recoveryKeys.companyId, me.companyId), isNull(recoveryKeys.retiredAt))).limit(1);
    const [maker] = active ? await db.select({ name: people.name }).from(people).where(eq(people.id, active.madeBy)) : [];
    const cored = await db.select().from(machines).where(and(eq(machines.companyId, me.companyId), isNull(machines.revokedAt), isNotNull(machines.networkId)));
    const own = await findThisMachine(db, config);
    const online = (reportAt: Date | null) => reportAt !== null && Date.now() - reportAt.getTime() < ONLINE_MS;
    const where = (id: string) =>
      cored
        .filter(machine => machine.heldBackups.includes(id))
        .map(machine => (machine.id === own?.id ? { machine: null, name: 'this server', online: true } : { machine: machine.id, name: machine.hostname, online: online(machine.reportAt) }))
        .sort((a, b) => Number(a.machine !== null) - Number(b.machine !== null) || a.name.localeCompare(b.name));
    return {
      last: rows[0]?.madeAt ?? null,
      recovery: active ? { madeAt: active.madeAt.toISOString(), madeBy: maker?.name ?? '' } : null,
      recoveryNeeded: !active,
      linkChanged: Boolean(newest) && (await linkChanged(db, config)),
      bundles: rows.map(row => ({ id: row.id, dumpedAt: row.dumpedAt, reason: row.reason, size: row.size, recovery: row.recovery === null ? 'none' : row.recovery === active?.recipient ? 'current' : 'older', where: where(row.id) })),
    };
  });
}
