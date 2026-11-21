import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { cameOverHttps } from '../../auth/tunnel.js';
import { companies, COPY_ERRORS, COPY_STATES, LINK_PATHS, machines, publicLinks, UPDATE_STATES, type MachineRole, type UploadState } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { REPORT_MAX } from '../backups/types.js';
import { holdsData } from '../copies/holds.js';
import { noteReplicaBytes } from '../copies/measured.js';
import { copyOrder } from '../copies/slots.js';
import { isPrivate } from '../keeper/addresses.js';
import { TABLE_SYNC_SLOT } from '../keeper/slots.js';
import { UPLOAD_SPARE, type UploadAllowed } from '../keeper/uploads.js';
import { queryOf } from '../merge/leader.js';
import { makeCrl } from './authority.js';
import { followOf, installs, releaseHeld } from './follow.js';
import { NETWORK_ID } from './ids.js';
import { countOnline, dataMachines, lockLiveMachine, notAMachine, redeemTicket, signedRenewal, viewFor, visitorKeyOf, workerLink, workerView } from './join.js';
import { authorityOf, certify, findThisMachine, makeAuthorityOnce, networkMachine, peerSecret, revokedSerials, thisMachine } from './store.js';
import { keeperAsker, type Asker } from './via.js';

/* A machine reports the addresses of its local networks, and the one loopback address that only tests report. */
const isPrivateAddress = (address: string): boolean => isPrivate(address) || address === '127.0.0.1';

const SignKey = z.string().min(1).max(1024);
const CertificateBody = z.object({ signKey: SignKey });
const JoinBody = z.object({ ticket: z.base64url().length(43), networkId: z.string().regex(NETWORK_ID), signKey: SignKey, signature: z.base64().length(88) });
const RenewBody = z.object({ machine: z.uuid(), serial: z.string().regex(/^[0-9a-f]{1,64}$/), at: z.iso.datetime(), signature: z.string().min(1).max(200) });
const Port = z.number().int().min(1).max(65535);
const Measure = z.number().int().min(0).max(600_000);
const ReportBody = z.object({
  uptimeS: z.number().int().min(0).optional(),
  fsyncP99Ms: z.number().min(0).nullable().optional(),
  diskFree: z.number().int().min(0).optional(),
  /* The memory and the processors Docker gives the machine. */
  memory: z.number().int().min(0).optional(),
  cores: z.number().int().min(1).max(4096).optional(),
  commit: z.string().max(64).optional(),
  webPort: Port.optional(),
  peerPort: Port.optional(),
  /* Where the machine can be dialed on its local networks, and how it reaches the server now. */
  addresses: z.array(z.string().refine(isPrivateAddress)).max(8).optional(),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional(),
  path: z.enum(LINK_PATHS).nullable().optional(),
  directFails: z.boolean().optional(),
  /* How far the machine is with the server's build: downloaded, installing, or failed at it. Null: with none. */
  update: z.object({ commit: z.string().min(1).max(64), state: z.enum(UPDATE_STATES) }).nullable().optional(),
  /* The system of the computer, as its installer wrote it down; left out when not known, and the row keeps what its
     node's join said. */
  os: z.enum(['linux', 'darwin']).optional(),
  /* The public half of the age key its keeper made, and the bundles it holds: its newest sixteen at most. */
  ageKey: z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/).optional(),
  heldBackups: z.array(z.uuid()).max(REPORT_MAX).optional(),
  /* The print of the owner's key the machine pinned from the command its owner ran there; null with none. */
  pin: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().optional(),
  /* Its copy of the company's database, from a machine that keeps one. */
  copy: z
    .object({
      state: z.enum(COPY_STATES),
      progress: z.number().int().min(0).max(99).nullable(),
      error: z.enum(COPY_ERRORS).nullable(),
      at: z.iso.datetime().nullable(),
      name: z.string().regex(/^copy_[0-9a-f]{16}_[1-9][0-9]{0,8}$/).nullable(),
      /* led: the number of the term its old database led under, when it led. */
      old: z.object({ attempt: z.number().int().min(1), led: z.number().int().min(0).optional() }).nullable(),
      /* The leader's slots of its tables whose first copy broke off. */
      left: z.array(z.string().regex(TABLE_SYNC_SLOT)).max(200).optional(),
    })
    .optional(),
  replicaBytes: z.number().int().min(0).optional().catch(undefined),
  /* A machine that stopped holding the data holds nothing of it any more. */
  wiped: z.literal(true).optional(),
  /* What the server order is scored on, as the machine itself measures it over a day: the round trip of its hellos to
     the leader, and its round trip and download rate to the internet. A measure it has none of yet is left out. */
  linkRttMs: Measure.optional(),
  internetRttMs: Measure.optional(),
  internetMbps: Measure.optional(),
});

/* held: the commands whose files the keeper still has, a few at most, as its updater runs one at a time. */
const ComputerQuery = z.object({
  updater: z.enum(['0', '1']).default('0'),
  /* Only an updated keeper can take standing access. */
  standing: z.literal('1').optional(),
  held: z
    .string()
    .max(8 * 37)
    .default('')
    .transform(text => (text ? text.split(',') : []))
    .pipe(z.array(z.uuid()).max(8)),
});
const ComputerAnswer = z.object({ exit: z.number().int().min(0).max(255), output: z.string() });

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const keyChanged = () => new ApiError(409, 'conflict', "This machine's key changed. Connect it again with a new command.", 'key_changed');

/* The term a machine says its old database led under, as the merge's source can name it: any other number leaves the
   database to be read as a copy's, which is compared the whole way all the same once it wrote. */
const ledOf = (led: number | undefined): number | null => (led !== undefined && led >= 1 && led <= 999_999_999 ? led : null);

/* How a machine's row keeps what its keeper said of its copy; a copy that names no subscription keeps the one the row has. */
function copyColumns(copy: NonNullable<z.infer<typeof ReportBody>['copy']>, copyName: string | null) {
  return { copyState: copy.state, copyProgress: copy.progress, copyError: copy.error, copyAt: copy.at ? new Date(copy.at) : null, copyName: copy.name ?? copyName ?? null, copyOld: copy.old?.attempt ?? null, copyOldLed: ledOf(copy.old?.led) };
}

/* networkId: the id the machine's keeper runs under, which the slot a new leader made for its copy is named by. */
type Holder = { id: string; networkId: string | null; role: MachineRole; personId: string | null; copyName: string | null; copyOld: number | null; copyOldLed: number | null; uploadState: UploadState | null };

/* What a keeper asks the app for: a certificate for the machine's key, the list of revoked certificates with what the
   machine offers its peers or needs to reach them, and a place for the machine's measures. Each answers only a keeper,
   for the machine the app runs on, or for a peer machine the keeper's peer door named by its certificate. A machine that
   has no certificate yet, or none that still works, comes with a ticket or its key's signature instead. */
export function networkRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* The keeper's routes ask this first: who is not a keeper gets no further. */
  const requireKeeper = async (req: FastifyRequest): Promise<Asker> => {
    const who = await keeperAsker(req, config);
    if (!who) throw notKeeper();
    return who;
  };
  const leading = () => ctx.mode.current() === 'lead';
  /* The database holds one company, the one this app serves. */
  const companyId = async (): Promise<string> => {
    const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
    if (!company) throw new ApiError(409, 'conflict', 'Hornhoof is not set up yet.');
    return company.id;
  };

  /* An older certificate of the machine is not revoked: it ends by itself. The app's own machine gets its row here, with
     whatever key its keeper holds now; a peer's must be the row it joined as, with the key it joined with. */
  app.post('/api/network/certificate', async req => {
    const who = await requireKeeper(req);
    const { signKey } = CertificateBody.parse(req.body);
    const company = await companyId();
    const id = who.own ? (await thisMachine(db, config, company)).id : who.machine;
    const authority = await makeAuthorityOnce(db, config, company);
    const { role, issued } = await db.transaction(async tx => {
      const row = await lockLiveMachine(tx, id);
      /* A certificate that opens the data goes only to a row whose person sees the whole company, whatever the row
         still says: one a restore brought back gets a worker's until the ranking takes its data away. */
      const role = who.own ? 'data' : row?.role === 'data' && !(await holdsData(tx, row.personId)) ? 'worker' : row?.role;
      if (!row || !role) throw notAMachine();
      if (who.own) await tx.update(machines).set({ signKey }).where(eq(machines.id, id));
      else if (row.signKey !== signKey) throw keyChanged();
      return { role, issued: await certify(tx, authority, { id, role, signKey }) };
    });
    return { machine: id, role, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
  });

  /* The machine the asker is, when it is one of the network. */
  async function machineOf(who: Asker): Promise<Holder | null> {
    if (who.own) {
      const mine = await findThisMachine(db, config);
      return mine ? { id: mine.id, networkId: config.machineId, role: 'data', personId: null, copyName: null, copyOld: null, copyOldLed: null, uploadState: null } : null;
    }
    const row = await networkMachine(db, who.machine);
    if (!row) throw notAMachine();
    return { id: row.id, networkId: row.networkId, role: row.role!, personId: row.personId, copyName: row.copyName, copyOld: row.copyOld, copyOldLed: row.copyOldLed, uploadState: row.uploadState };
  }

  /* What a data machine offers its peers through the relay, the way to the data among it. None without a public link,
     and none while a secret is missing where the app does not lead and so makes none. visit: the key that logs a
     visitor in at the relay goes with it, for a machine that reaches other data machines there; it is asked of the
     relay only once there is another such machine. */
  async function linkOf(machine: Holder | null, visit: boolean) {
    const [link] = machine ? await db.select(only(publicLinks, 'name')).from(publicLinks).limit(1) : [];
    if (!machine || !link) return null;
    const appSecret = await peerSecret(db, config, 'app', leading());
    const dataSecret = await peerSecret(db, config, 'data', leading());
    if (!appSecret || !dataSecret) return null;
    const visitorKey = visit ? await visitorKeyOf(ctx) : null;
    return { name: link.name, appSecret, dataSecret, ...(visitorKey ? { visitorKey } : {}) };
  }

  /* The machines that stopped holding the data and still owe what they held. An upload may be three times the leader's
     own database and a spare, and four times unpacked: a copy holds no more than the leader did, and CSV is larger than
     the rows it came from. */
  async function uploadsOwed(): Promise<UploadAllowed[]> {
    const owing = await db
      .select({ machine: machines.id, networkId: machines.networkId })
      .from(machines)
      .where(and(eq(machines.uploadState, 'waiting'), isNull(machines.revokedAt), isNotNull(machines.networkId)))
      .orderBy(machines.dataLeftAt, machines.id);
    if (owing.length === 0) return [];
    const [sized] = await queryOf(db)<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
    const size = Number(sized?.size ?? 0);
    return owing.map(row => ({ machine: row.machine, networkId: row.networkId!, max: 3 * size + UPLOAD_SPARE, unpackMax: 4 * size + UPLOAD_SPARE }));
  }

  /* A worker gets the link as it uses it, with the visitor key and never the way to the data; either kind also learns
     where the data machines are. */
  app.get('/api/network/peers', async req => {
    const who = await requireKeeper(req);
    const machine = await machineOf(who);
    const authority = await authorityOf(db, config);
    const revoked = await revokedSerials(db);
    /* Only the leader signs, so only it uses the authority's key. */
    const crlPem = authority && leading() ? await makeCrl(authority, revoked) : null;
    const data = await dataMachines(db);
    /* A machine that joined gets the link as it uses it, and its role, which changes when the server gives it the data
       or takes it away; one that holds the data gets the way to it too. A link that cannot be told now is left out, and
       the machine keeps the one it has. */
    const peer = !who.own && machine ? machine : null;
    const copy = peer?.role === 'data' && peer.personId !== null && (await holdsData(db, peer.personId));
    const link = peer ? await workerLink(ctx, copy) : await linkOf(machine, data.length > 1);
    /* A machine that joined also hears of the server's build, and when it may install it. */
    const follow = peer ? await followOf(ctx, peer.id) : {};
    /* The machine's own keeper also hears which copies' databases a merge is to read, and opens a door to each. */
    const doors = who.own ? { doors: await ctx.doorsWanted() } : {};
    /* And which machines owe it what they held, and how large that may be. */
    const uploads = who.own ? { uploads: await uploadsOwed(), leftSlots: ctx.leftSlots.now() } : {};
    /* A machine that keeps a copy hears of its slot here, and how far the leader's database has grown; one that stopped
       keeping one, what it still owes. */
    const told = peer ? { role: peer.role, copy: peer.role === 'data' || peer.uploadState ? await copyOrder(ctx, peer) : null } : {};
    return { machine: machine?.id ?? null, ...told, authorityPem: authority?.certPem ?? null, revoked, crlPem, ...(link === undefined ? {} : { link }), data, ...follow, ...doors, ...uploads };
  });

  /* Each report also counts as time online, by the time of the one before. A name is taken for the server's own row
     alone, which has none else: a computer someone joined said its name then. */
  app.post('/api/network/report', async (req, reply) => {
    const who = await requireKeeper(req);
    const { hostname, update, pin, copy, wiped, replicaBytes, fsyncP99Ms, ...told } = ReportBody.parse(req.body ?? {});
    /* A keeper that just started has not timed its disk yet: the row keeps the last it said. */
    const said = { ...told, ...(fsyncP99Ms == null ? {} : { fsyncP99Ms }) };
    const machine = await machineOf(who);
    if (!machine) return reply.code(204).send();
    const installed = await db.transaction(async tx => {
      const [row] = await tx.select().from(machines).where(eq(machines.id, machine.id)).for('update');
      const now = new Date();
      await countOnline(tx, machine.id, row?.reportAt ?? null, now);
      /* A failure at the build it was told to install, or at the one it downloaded, is remembered, so it is not told
         again at once. */
      /* Said once, when the machine first says so: it goes on saying it with every report, and the hours until the next
         try count from the failure, not from its last mention. */
      const news = update?.state === 'failed' && !(row?.updateState === 'failed' && row.failedCommit === update.commit);
      const failed = news ? { failedCommit: update.commit, failedAt: now } : {};
      const follows = update === undefined ? {} : { updateCommit: update?.commit ?? null, updateState: update?.state ?? null, ...failed };
      /* A report that says nothing of the pin keeps the one the machine said before. */
      const pinned = pin === undefined ? {} : { ownerPin: pin };
      /* Only a machine the server gave the data says anything of a copy; and never the one that leads. */
      const copied = copy === undefined || who.own || row?.role !== 'data' ? {} : copyColumns(copy, row.copyName);
      if ('copyState' in copied) ctx.leftSlots.say(machine.id, copy?.left);
      /* A machine that owed what it held and holds nothing now owes nothing, and its row says nothing of a copy but
         its name: the next copy on that machine starts at the attempt above it, so no name is used twice. */
      const left = wiped && !who.own && row?.role !== 'data' && row?.uploadState ? { uploadState: null, copyState: null, copyProgress: null, copyError: null, copyAt: null, copyOld: null, copyOldLed: null } : {};
      const [after] = await tx.update(machines).set({ ...said, ...follows, ...pinned, ...copied, ...left, ...(who.own && hostname ? { hostname } : {}), reportAt: now }).where(eq(machines.id, machine.id)).returning();
      /* The next copy on that machine starts above the last, by the name the row keeps. Should a keeper ever count
         from 1 again all the same, the merges of its old copies give their names up here, and one the leader never
         read is ended: that database is gone. */
      if ('uploadState' in left) {
        await queryOf(tx)(
          `UPDATE net.merges SET source = source || ':wiped:' || id::text, status = 'done', done_at = COALESCE(done_at, now()),
                  error = CASE WHEN status IN ('pending', 'applied') THEN $2 ELSE error END
            WHERE machine = $1::uuid AND source ~ '^machine:[0-9a-f-]{36}:[0-9]+$'`,
          [machine.id, 'The machine was wiped before its old copy was read.'],
        );
      }
      /* Its turn to install is over once it says so: it runs the build, or the install failed. */
      return {
        installed: Boolean(row && after && installs(row, now) && !installs(after, now)),
        looked: pin !== undefined && pin !== row?.ownerPin,
        companyId: row?.companyId,
        measured: !who.own && (row?.role === 'data' || Boolean(row?.uploadState)),
        wiped: 'uploadState' in left,
      };
    });
    if (installed.wiped) noteReplicaBytes(ctx, machine.id, null);
    else if (installed.measured && replicaBytes !== undefined) noteReplicaBytes(ctx, machine.id, replicaBytes);
    if (installed.installed) void releaseHeld(ctx);
    /* The screens load the machine again when its pinned key changes. */
    if (installed.looked && installed.companyId) ctx.bus.publish(installed.companyId, { type: 'computer' });
    return reply.code(204).send();
  });

  async function computerOf(who: Asker): Promise<Holder> {
    if (!leading()) throw new ApiError(503, 'unavailable', 'This server does not serve computer access now.');
    const machine = await machineOf(who);
    if (!machine) throw notAMachine();
    return machine;
  }

  /* A machine's keeper asks for its machine's access and its next command, saying whether its updater is alive and
     which commands it still holds. Asking is what makes the machine reachable. */
  app.get('/api/network/computer', async req => {
    const machine = await computerOf(await requireKeeper(req));
    const { updater, held, standing } = ComputerQuery.parse(req.query);
    if (!standing) return { access: null, runs: [], forget: held };
    ctx.computer.seen(machine.id, updater === '1');
    return ctx.computer.take(machine.id, held);
  });

  /* The keeper brings back the answer of a command it took. */
  app.post('/api/network/computer/:id', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const machine = await computerOf(await requireKeeper(req));
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await ctx.computer.answer(machine.id, id, ComputerAnswer.parse(req.body)))) throw new ApiError(404, 'not_found', 'This machine has no such command out.');
    return reply.code(204).send();
  });

  /* A machine's keeper comes here once with the ticket its join command brought and a signature from its key.
     The link's secrets go only into an answer that travels over TLS. */
  app.post('/api/network/join', async req => {
    const { machine, role, issued, authorityPem } = await redeemTicket(ctx, JoinBody.parse(req.body));
    const view = viewFor(await workerView(ctx, machine, role), await cameOverHttps(req, config));
    return { machine, role, certPem: issued.certPem, authorityPem, until: issued.until.toISOString(), view };
  });

  /* A machine whose certificate ended, or whose secrets changed, asks again by its key's signature. */
  app.post('/api/network/renew', async (req, reply) => {
    const { status, answer } = await signedRenewal(ctx, RenewBody.parse(req.body), await cameOverHttps(req, config));
    return reply.code(status).send(answer);
  });
}
