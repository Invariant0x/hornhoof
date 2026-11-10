import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { certificates, companies, machines, publicLinks, type MachineRole } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { issueCertificate, makeCrl } from './authority.js';
import { authorityOf, findThisMachine, makeAuthorityOnce, networkMachine, peerSecret, revokedSerials, thisMachine } from './store.js';
import { askerOf, type Asker } from './via.js';

const CertificateBody = z.object({ signKey: z.string().min(1).max(1024) });
const Port = z.number().int().min(1).max(65535);
const ReportBody = z.object({
  uptimeS: z.number().int().min(0).optional(),
  fsyncP99Ms: z.number().min(0).nullable().optional(),
  diskFree: z.number().int().min(0).optional(),
  commit: z.string().max(64).optional(),
  webPort: Port.optional(),
  peerPort: Port.optional(),
});

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const notAMachine = () => new ApiError(404, 'not_found', "This machine is not one of the company's network.", 'not_a_machine');
const keyChanged = () => new ApiError(409, 'conflict', "This machine's key changed. Connect it again with a new command.", 'key_changed');

type Holder = { id: string; role: MachineRole };

/* What the keeper asks its app for: a certificate for the machine's key, the list of revoked certificates with what the
   machine offers its peers, and a place for the machine's measures. Each answers only the keeper, for the machine the app
   runs on, or a peer machine the keeper's peer door named by its certificate. */
export function networkRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* Every route here asks this first: who is not the keeper gets no further. */
  const requireKeeper = async (req: FastifyRequest): Promise<Asker> => {
    const who = await askerOf(req, config);
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

  /* The machine a certificate is for. The app's own gets its row here, with whatever key its keeper holds now; a peer's
     must be the row it joined as, with the key it joined with. */
  async function holderOf(who: Asker, signKey: string): Promise<Holder> {
    if (who.own) {
      const mine = await thisMachine(db, config, await companyId());
      await db.update(machines).set({ signKey }).where(eq(machines.id, mine.id));
      return { id: mine.id, role: 'data' };
    }
    const row = await networkMachine(db, who.machine);
    if (!row) throw notAMachine();
    if (row.signKey !== signKey) throw keyChanged();
    return { id: row.id, role: row.role! };
  }

  /* An older certificate of the machine is not revoked: it ends by itself. */
  app.post('/api/network/certificate', async req => {
    const who = await requireKeeper(req);
    const { signKey } = CertificateBody.parse(req.body);
    const holder = await holderOf(who, signKey);
    const authority = await makeAuthorityOnce(db, config, await companyId());
    const issued = await issueCertificate(authority, { machineId: holder.id, role: holder.role, signKey }).catch((err: Error) => {
      throw new ApiError(400, 'validation', err.message);
    });
    await db.insert(certificates).values({ serial: issued.serial, machineId: holder.id, until: issued.until });
    return { machine: holder.id, role: holder.role, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
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

  /* What the machine offers its peers through the relay. None without a public link, and none while a secret is missing
     where the app does not lead and so makes none. The way to the data is told only to a machine that keeps data. */
  async function linkOf(machine: Holder | null) {
    const [link] = machine ? await db.select({ name: publicLinks.name }).from(publicLinks).limit(1) : [];
    if (!machine || !link) return null;
    const appSecret = await peerSecret(db, config, 'app', leading());
    const dataSecret = machine.role === 'data' ? await peerSecret(db, config, 'data', leading()) : undefined;
    if (!appSecret || dataSecret === null) return null;
    return { name: link.name, appSecret, ...(dataSecret ? { dataSecret } : {}) };
  }

  app.get('/api/network/peers', async req => {
    const machine = await machineOf(await requireKeeper(req));
    const authority = await authorityOf(db, config);
    const revoked = await revokedSerials(db);
    /* Only the leader signs, so only it uses the authority's key. */
    const crlPem = authority && leading() ? await makeCrl(authority, revoked) : null;
    return { machine: machine?.id ?? null, authorityPem: authority?.certPem ?? null, revoked, crlPem, link: await linkOf(machine) };
  });

  app.post('/api/network/report', async (req, reply) => {
    const who = await requireKeeper(req);
    const said = ReportBody.parse(req.body ?? {});
    const machine = await machineOf(who);
    if (machine) await db.update(machines).set({ ...said, reportAt: new Date() }).where(eq(machines.id, machine.id));
    return reply.code(204).send();
  });
}
