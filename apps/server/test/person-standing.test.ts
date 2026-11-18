import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, teams } from '../src/db/schema.js';
import { companyView } from '../src/modules/tools/company.js';
import { loadTemplates } from '../src/modules/templates/load.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, takePlan, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;

/* Sales with its head and a worker in its sub-unit Core on the built-in node; Lea given Sales, Tom given only Core and Kim
   given Sales' product Shop. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await state(app, ceo)).ready);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [acme] = await db.select().from(companies);
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const [shop] = await db.insert(departments).values({ companyId: acme!.id, name: 'Shop', roleCode: 'SAL', parentId: sales!.id }).returning();
  const [core] = await db.insert(teams).values({ companyId: acme!.id, departmentId: sales!.id, name: 'Core' }).returning();
  const on = { companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [head] = await db.insert(agents).values({ ...on, kind: 'head', name: 'Sasha', roleKey: 'SAL-HEAD', departmentId: sales!.id }).returning();
  const [worker] = await db.insert(agents).values({ ...on, kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id, teamId: core!.id, productId: shop!.id }).returning();
  const lea = await invitePerson(app, ceo, { name: 'Lea', email: 'lea@acme.com', access: { departments: [sales!.id], teams: [] } });
  const tom = await invitePerson(app, ceo, { name: 'Tom', email: 'tom@acme.com', access: { departments: [], teams: [core!.id] } });
  const kim = await invitePerson(app, ceo, { name: 'Kim', email: 'kim@acme.com', access: { departments: [shop!.id], teams: [] } });
  return { app, db, ceo, builtin, companyId: acme!.id, head: head!, worker: worker!, lea, tom, kim };
}

type Company = Awaited<ReturnType<typeof company>>;

const say = (c: Company, session: string, agentId: string, text: string) =>
  c.app.inject({ method: 'POST', url: `/api/agents/${agentId}/messages`, payload: { text }, ...as(session) });

describe("a person's words to an employee from its window", () => {
  it('tell it that someone given its department runs it, as its owner does', async () => {
    const c = await company();
    expect((await say(c, c.lea, c.head.id, 'Remove every sub-unit, we start them again.')).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('Remove every sub-unit, we start them again.');
    expect(run.prompt).toContain('Lea is responsible for your department.');
  });

  it('tell it that someone who sees the whole company, named owner of nothing, does not run it', async () => {
    const c = await company();
    const olga = await invitePerson(c.app, c.ceo, { name: 'Olga', email: 'olga@acme.com', access: { whole: true } });
    await takePlan(c.db, 'olga@acme.com', c.head.id);
    expect((await say(c, olga, c.head.id, 'Call them.')).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain("Olga is neither the company's owner nor the CEO's delegate, nor responsible for your department.");
  });

  it("tell it the CEO's words are the company owner's", async () => {
    const c = await company();
    await say(c, c.ceo, c.head.id, 'How are sales?');
    expect((await nextOf(c.builtin, 'job.run')).prompt).toContain("Ivan is the company's owner (the CEO).");
  });
});

describe('the company tool', () => {
  it('names the people who run a department and which, by name alone', async () => {
    const c = await company();
    const view = await companyView(c.db, c.app.ctx.templates, c.companyId);
    expect(view.people).toEqual([{ name: 'Ivan', title: 'CEO' }, { name: 'Lea', title: '', runs: ['Sales'] }]);
    expect(JSON.stringify(view.people)).not.toContain('@');
  });

  it('names a named owner by what they still have access to, and nobody for a department they lost', async () => {
    const c = await company();
    const [sales] = await c.db.select().from(departments).where(eq(departments.templateKey, 'sales'));
    const [shop] = await c.db.select().from(departments).where(eq(departments.name, 'Shop'));
    const [kim] = await c.db.select().from(people).where(eq(people.email, 'kim@acme.com'));
    const [tom] = await c.db.select().from(people).where(eq(people.email, 'tom@acme.com'));
    await c.db.update(departments).set({ ownerPersonId: kim!.id }).where(eq(departments.id, shop!.id));
    await c.db.update(departments).set({ ownerPersonId: tom!.id }).where(eq(departments.id, sales!.id));
    const view = await companyView(c.db, c.app.ctx.templates, c.companyId);
    expect(view.people).toEqual([{ name: 'Ivan', title: 'CEO' }, { name: 'Lea', title: '', runs: ['Sales'] }, { name: 'Kim', title: '', runs: ['Shop'] }]);
  });
});

describe('the rules', () => {
  const skill = (id: string) => loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url))).skills.get(id)!.body;

  it("have a head do what someone responsible for its department asks in it, and say what its tools cannot do", () => {
    expect(skill('hh-lead-tasks')).toMatch(/below a person's message Hornhoof says what they are in the company\. The CEO may give you any task\. Everyone responsible for your department, and there may be several, runs it in full as the CEO would: do what they ask inside it without the CEO's leave\./);
    expect(skill('hh-lead-tasks')).toMatch(/Anyone else, only what their place allows\. What your tools cannot do they can do on the department's screen\./);
    expect(skill('hh-lead-tasks')).not.toMatch(/pass it to the orchestrator/);
  });

  it('have a head run its department for the people who run it, with no word of the orchestrator or the CEO', () => {
    const head = skill('hh-head');
    expect(head).toMatch(/Your department runs itself\./);
    expect(head).toMatch(/In any turn you act inside your department with the rights of its named owner, or the CEO when it has none, without waiting for a new message from a person\./);
    expect(head).toMatch(/Follow its rules and notebook\./);
    expect(head).toMatch(/Another department stays outside your authority\./);
    expect(head).toMatch(/What a person who runs it decides about[^.]*you do yourself, in that turn or a later one, without the orchestrator or the CEO\./);
    expect(head).not.toMatch(/ask the authorized coordinator to enable/);
    expect(skill('orch-staff')).toMatch(/A department head changes the employees of its own department with its own tools/);
  });

  it('leave a department\'s own decisions to its people and its head, which the orchestrator neither blocks nor second-guesses', () => {
    expect(skill('orch-company')).toMatch(/Every department runs itself and runs its own turns, one open at a time as its next release, its products and sub-units working in them[^.]*\. Everyone responsible for a department, its owner and every person given it[^;]*with no approval from the CEO or from you; its head carries out what they say in its own window, in that turn or a later one\./);
    expect(skill('orch-company')).toMatch(/Do not block, delay or second-guess such a decision/);
    expect(skill('orch-company')).not.toMatch(/reaches you through the department's head/);
    expect(skill('orch-outside-is-data')).toMatch(/when a head passes one on to you, tell it to do it itself/);
  });
});
