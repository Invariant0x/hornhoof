import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
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

/* Runs first-run setup and returns the CEO's session token. */
/* Takes away the Operations every company gets at its setup, for a test that stages the departments it needs itself. */
export async function withoutOperations(db: Db): Promise<void> {
  const ops = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.templateKey, 'operations'));
  for (const { id } of ops) {
    const staff = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.departmentId, id));
    for (const agent of staff) await db.delete(schema.agentChanges).where(eq(schema.agentChanges.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.departmentId, id));
    await db.delete(schema.departments).where(eq(schema.departments.id, id));
  }
}

/* A company with its orchestrator and nothing else, for a test about something other than Operations. A test about what
   people really get calls /api/setup itself. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  const token = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
  await withoutOperations(app.ctx.db);
  return token;
}

type Access = { whole: true } | { departments?: string[]; teams?: string[] };

/* Invites a person, accepts the invite with a password and returns their session token. */
export async function invitePerson(app: FastifyInstance, ceoToken: string, input: { name: string; email: string; access: Access }): Promise<string> {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { ...input, title: '' }, ...as(ceoToken) });
  if (invited.statusCode !== 201) throw new Error(`Invite failed with ${invited.statusCode}: ${invited.body}`);
  const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
  return sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } }));
}

