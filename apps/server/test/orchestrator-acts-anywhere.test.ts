import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, companies, people } from '../src/db/schema.js';
import { setUpCompany, testApp } from './helpers.js';

/* Ivan's word of 17 November 2026: the orchestrator can do everything, so no route turns it away for being an agent. */
async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [bruno] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', model: '' }).returning();
  return { app, owner: owner!, bruno: bruno!, headers: orchestratorHeaders(owner!.id, orchestrator!.id) };
}

it("sets up a person's assistant, as the person would on their own screen", async () => {
  const c = await company();
  const res = await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: 'Ava', owner: c.owner.id, program: 'avaclone' }, headers: c.headers });
  expect([res.statusCode, res.json().person?.name]).toEqual([201, 'Ava']);
});

it('sends an employee a file, as a person does', async () => {
  const c = await company();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const res = await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/pictures?name=screen.png`, payload: png, headers: { ...c.headers, 'content-type': 'application/octet-stream' } });
  expect([res.statusCode, res.json().name]).toEqual([201, 'screen.png']);
});
