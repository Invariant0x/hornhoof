import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { companies } from '../src/db/schema.js';
import { Computers } from '../src/modules/computer/access.js';
import { idOnly } from '../src/db/selections.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { thisMachine } from '../src/modules/network/store.js';
import { fixture } from './helpers-db.js';

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

/* A turn of the event loop as the real clock gives it, taken when this file loads, so a test's fake clock never stops it. */
const turn = setImmediate;

/* What a wait for a command's answer does between its looks in a test: it looks again after a turn of the event loop, with
   no timer, so an answer is seen as soon as it is there and only the test's own clock ends a wait. */
export const nextTurn = (): Promise<void> => new Promise(resolve => { turn(resolve); });

/* Computer access of the test app whose waits for an answer take no time of the real clock. waitMs: how long one tool call
   waits, on the clock Date gives. */
export function testComputers(app: FastifyInstance, opts: { waitMs?: number } = {}): Computers {
  const computer = new Computers(app.ctx, { ...opts, pause: nextTurn });
  computer.moveLegacy(app.ctx.config.controlDir);
  app.ctx.computer = computer;
  return computer;
}

/* Rows the tests of a file start from, made once through the real code as fixture() in helpers-db.ts keeps them, for apps
   that differ only in their control folder: each test has a folder of its own, and no row of a company holds it. at: the
   frozen time of the test's clock, when it is not real. */
export async function companyRows<T>(app: FastifyInstance, key: string, make: () => Promise<T>, at?: Date): Promise<T> {
  await app.ready();
  const config = { ...app.ctx.config, controlDir: '' };
  const { $client } = app.ctx.db as unknown as { $client: PGlite };
  return fixture($client, `${key} ${JSON.stringify(config)}`, make, at && { at: at.getTime() });
}
