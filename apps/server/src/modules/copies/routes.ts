import { Encrypter } from 'age-encryption';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import type { BundleSecrets } from '../backups/bundle.js';
import { notAMachine } from '../network/join.js';
import { networkMachine } from '../network/store.js';
import { keeperAsker, type Asker } from '../network/via.js';
import { holdsData } from './holds.js';

const notKeeper = () => new ApiError(403, 'forbidden', "Only this machine's keeper may ask this.", 'not_keeper');
const notData = () => new ApiError(403, 'forbidden', "This machine does not hold the company's data.", 'not_data');
const noAgeKey = () => new ApiError(409, 'conflict', 'This machine has not said its key for backups yet.', 'no_age_key');
const notLeading = () => new ApiError(503, 'unavailable', 'This server does not lead the company now. Try again in a few seconds.');

export function copiesRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* Who is not a keeper gets no further. */
  const requireKeeper = async (req: FastifyRequest): Promise<Asker> => {
    const who = await keeperAsker(req, config);
    if (!who) throw notKeeper();
    return who;
  };

  /* A machine that the ranking gave the data asks for what it needs to keep it: the company's secret, the key its node
     signs in with, and the relay's address. They go out only sealed to the key that machine's keeper made, so nothing
     on the way and no other machine reads them, and only to the keeper of a live machine whose row says data and
     whose person sees the whole company. */
  app.post('/api/network/secrets', async (req, reply) => {
    const who = await requireKeeper(req);
    if (who.own) throw notData();
    const row = await networkMachine(db, who.machine);
    if (!row) throw notAMachine();
    if (row.role !== 'data' || !(await holdsData(db, row.personId))) throw notData();
    if (ctx.mode.current() !== 'lead') throw notLeading();
    if (!row.ageKey) throw noAgeKey();
    const secrets: BundleSecrets = { HORNHOOF_SECRET: config.secret.toString('base64'), NODE_KEY: config.nodeKey ?? '', RELAY_URL: config.relayUrl };
    const encrypter = new Encrypter();
    encrypter.addRecipient(row.ageKey);
    const sealed = Buffer.from(await encrypter.encrypt(JSON.stringify(secrets))).toString('base64');
    return reply.header('cache-control', 'no-store').send({ sealed });
  });
}
