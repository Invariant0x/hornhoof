import type { FastifyInstance } from 'fastify';
import { companies } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { thisMachine } from '../src/modules/network/store.js';

/* What a test app is started with so that the server it runs on is a machine of the company's network. */
export const SERVER_MACHINE_ENV = { HORNHOOF_MACHINE_ID: hostIdOf('server-0001-abcd') };

/* The server's own machine of the test company, with its keeper asking and its updater alive: the machine computer
   access is asked for when none is named. */
export async function serverMachine(app: FastifyInstance): Promise<string> {
  const [company] = await app.ctx.db.select(idOnly(companies)).from(companies);
  const { id } = await thisMachine(app.ctx.db, app.ctx.config, company!.id);
  app.ctx.computer.seen(id, true);
  return id;
}
