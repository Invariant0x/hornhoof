import type { PGlite } from '@electric-sql/pglite';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { setupCode } from '../src/modules/setup/code.js';
import { as, sessionFrom, TEST_SECRET } from './helpers-basic.js';

export const TEST_API_KEY = 'sk-ant-api03-test-key-9f3a';
export const SETUP = {
  /* The code from the setup link the server logs while no company exists. */
  code: setupCode(Buffer.from(TEST_SECRET, 'base64')),
  companyName: 'Acme',
  name: 'Ivan',
  email: ' Ivan@Acme.com ',
  password: 'correct horse battery',
  orchestrator: { mode: 'api_key', provider: 'anthropic_api', apiKey: TEST_API_KEY },
};

/* Takes away the Operations every company gets at its setup, for a test that stages the departments it needs itself. */
export async function withoutOperations(db: Db): Promise<void> {
  const ops = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.templateKey, 'operations'));
  for (const { id } of ops) {
    const staff = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.departmentId, id));
    for (const agent of staff) await db.delete(schema.agentChanges).where(eq(schema.agentChanges.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.departmentId, id));
    const pipelines = await db.select({ id: schema.pipelines.id }).from(schema.pipelines).where(eq(schema.pipelines.departmentId, id));
    if (pipelines.length) {
      await db.delete(schema.pipelineStages).where(inArray(schema.pipelineStages.pipelineId, pipelines.map(p => p.id)));
      await db.delete(schema.pipelines).where(eq(schema.pipelines.departmentId, id));
    }
    /* The open turn every department gets, its release never begun. */
    await db.delete(schema.turns).where(eq(schema.turns.departmentId, id));
    await db.delete(schema.departments).where(eq(schema.departments.id, id));
  }
}

/* Rows a group of tests starts from, made on this app's database as fixture() in helpers-db.ts says, for an app as its
   config makes it. The app is ready first, as the first request makes it, so what it does as it comes up sees no rows of
   them whether they are made or put back. */
export async function appFixture<T>(app: FastifyInstance, key: string, make: () => Promise<T>): Promise<T> {
  await app.ready();
  /* Browser support processes own their app without Vitest's lifecycle or fixture cache. */
  if (!process.env.VITEST) return make();
  const { fixture } = await import('./helpers-db.js');
  const { $client } = app.ctx.db as unknown as { $client: PGlite | Pool };
  /* A real Postgres of test/real is a database of one file, made and dropped by it: nothing is kept for it. */
  if ('totalCount' in $client) return make();
  return fixture($client, `${key} ${JSON.stringify(app.ctx.config)}`, make);
}

/* A company with its orchestrator and nothing else, for a test about something other than Operations, and the CEO's
   session token. First-run setup runs once in a file; a test about what people really get calls /api/setup itself. Its
   mail goes each as a turn of its own, as a test about something other than the inbox expects; inbox.test.ts takes the
   inbox every company starts with. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  return appFixture(app, 'setUpCompany', async () => {
    const token = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
    await withoutOperations(app.ctx.db);
    await app.ctx.db.update(schema.companies).set({ inboxMode: 'direct' });
    return token;
  });
}

type Access = { whole: true } | { departments?: string[]; teams?: string[] };

/* Invites a person, accepts the invite with a password and returns their session token. */
export async function invitePerson(app: FastifyInstance, ceoToken: string, input: { name: string; email: string; access: Access }): Promise<string> {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { ...input, title: '' }, ...as(ceoToken) });
  if (invited.statusCode !== 201) throw new Error(`Invite failed with ${invited.statusCode}: ${invited.body}`);
  const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
  return sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } }));
}

