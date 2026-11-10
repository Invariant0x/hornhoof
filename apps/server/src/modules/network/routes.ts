import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { cameOverHttps } from '../../auth/tunnel.js';
import { companies, LINK_PATHS, machines, publicLinks, type MachineRole } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { isPrivate } from '../keeper/addresses.js';
import { makeCrl } from './authority.js';
import { NETWORK_ID } from './ids.js';
import { countOnline, dataMachines, lockLiveMachine, notAMachine, redeemTicket, signedRenewal, viewFor, workerLink, workerView } from './join.js';
import { authorityOf, certify, findThisMachine, makeAuthorityOnce, networkMachine, peerSecret, revokedSerials, thisMachine } from './store.js';
import { keeperAsker, type Asker } from './via.js';

/* A machine reports the addresses of its local networks, and the one loopback address that only tests report. */
const isPrivateAddress = (address: string): boolean => isPrivate(address) || address === '127.0.0.1';

const SignKey = z.string().min(1).max(1024);
const CertificateBody = z.object({ signKey: SignKey });
const JoinBody = z.object({ ticket: z.string().length(43), networkId: z.string().regex(NETWORK_ID), signKey: SignKey });
const RenewBody = z.object({ machine: z.uuid(), serial: z.string().regex(/^[0-9a-f]{1,64}$/), at: z.iso.datetime(), signature: z.string().min(1).max(200) });
const Port = z.number().int().min(1).max(65535);
const ReportBody = z.object({
  uptimeS: z.number().int().min(0).optional(),
  fsyncP99Ms: z.number().min(0).nullable().optional(),
  diskFree: z.number().int().min(0).optional(),
  commit: z.string().max(64).optional(),
  webPort: Port.optional(),
  peerPort: Port.optional(),
  /* Where the machine can be dialed on its local networks, and how it reaches the server now. */
  addresses: z.array(z.string().refine(isPrivateAddress)).max(8).optional(),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional(),
  path: z.enum(LINK_PATHS).nullable().optional(),
  directFails: z.boolean().optional(),
});

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const keyChanged = () => new ApiError(409, 'conflict', "This machine's key changed. Connect it again with a new command.", 'key_changed');

type Holder = { id: string; role: MachineRole };

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
    const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
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
      const role = who.own ? 'data' : row?.role;
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
      return mine ? { id: mine.id, role: 'data' } : null;
    }
    const row = await networkMachine(db, who.machine);
    if (!row) throw notAMachine();
    return { id: row.id, role: row.role! };
  }

  /* What a data machine offers its peers through the relay, the way to the data among it. None without a public link,
     and none while a secret is missing where the app does not lead and so makes none. */
  async function linkOf(machine: Holder | null) {
    const [link] = machine ? await db.select({ name: publicLinks.name }).from(publicLinks).limit(1) : [];
    if (!machine || !link) return null;
    const appSecret = await peerSecret(db, config, 'app', leading());
    const dataSecret = await peerSecret(db, config, 'data', leading());
    return appSecret && dataSecret ? { name: link.name, appSecret, dataSecret } : null;
  }

  /* A worker gets the link as it uses it, with the visitor key and never the way to the data; either kind also learns
     where the data machines are. */
  app.get('/api/network/peers', async req => {
    const machine = await machineOf(await requireKeeper(req));
    const authority = await authorityOf(db, config);
    const revoked = await revokedSerials(db);
    /* Only the leader signs, so only it uses the authority's key. */
    const crlPem = authority && leading() ? await makeCrl(authority, revoked) : null;
    /* A link that cannot be told now is left out, and a worker keeps the one it has. */
    const link = machine?.role === 'worker' ? await workerLink(ctx) : await linkOf(machine);
    return { machine: machine?.id ?? null, authorityPem: authority?.certPem ?? null, revoked, crlPem, ...(link === undefined ? {} : { link }), data: await dataMachines(db) };
  });

  /* Each report also counts as time online, by the time of the one before. A name is taken for the server's own row
     alone, which has none else: a computer someone joined said its name then. */
  app.post('/api/network/report', async (req, reply) => {
    const who = await requireKeeper(req);
    const { hostname, ...said } = ReportBody.parse(req.body ?? {});
    const machine = await machineOf(who);
    if (machine) {
      await db.transaction(async tx => {
        const [row] = await tx.select({ reportAt: machines.reportAt }).from(machines).where(eq(machines.id, machine.id)).for('update');
        const now = new Date();
        await countOnline(tx, machine.id, row?.reportAt ?? null, now);
        await tx.update(machines).set({ ...said, ...(who.own && hostname ? { hostname } : {}), reportAt: now }).where(eq(machines.id, machine.id));
      });
    }
    return reply.code(204).send();
  });

  /* A machine's keeper comes here once, before it has a certificate, with the ticket its join command brought. Whoever
     holds the ticket is that machine, so nothing else is asked. The link's secrets go only into an answer that travels
     over TLS; a keeper that joined over plain HTTP reads them through its peer link. */
  app.post('/api/network/join', async req => {
    const { machine, role, issued, authorityPem } = await redeemTicket(ctx, JoinBody.parse(req.body));
    const view = viewFor(await workerView(ctx, machine), await cameOverHttps(req, config));
    return { machine, role, certPem: issued.certPem, authorityPem, until: issued.until.toISOString(), view };
  });

  /* A machine whose certificate ended, or whose secrets changed, asks again by its key's signature. */
  app.post('/api/network/renew', async (req, reply) => {
    const { status, answer } = await signedRenewal(ctx, RenewBody.parse(req.body), await cameOverHttps(req, config));
    return reply.code(status).send(answer);
  });
}
