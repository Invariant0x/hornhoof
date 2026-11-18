import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, people, requests, subscriptions } from '../src/db/schema.js';
import { ask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, mcp } from './helpers.js';
import { company, nextOf } from './test-runs-company.js';

type Company = Awaited<ReturnType<typeof company>>;

const TOKEN = 'tool-token-orchestrator-0123456789abcdef';

/* The orchestrator's running turn, which no person's words started, and its tools. */
async function orchestrator(c: Company) {
  const [me] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const { call } = await c.turn(me!, null);
  return { me: me!, call };
}

describe('the orchestrator takes any tool of Hornhoof when it needs it', () => {
  it('lists the tools to find and call any other, and keeps the rest off its list', async () => {
    const c = await company();
    const [me] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [sub] = await c.db.select().from(subscriptions);
    await c.db.insert(jobs).values({ companyId: me!.companyId, subscriptionId: sub!.id, agentId: me!.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
    const names = (await (await mcp(c.app, TOKEN)).listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_tool', 'use_tool', 'api', 'propose_structure', 'change_employee']));
    expect(names).not.toContain('stop_tests');
    expect(names).not.toContain('change_department');
  });

  it('finds stop_tests by name, loads it and stops a run another agent started', async () => {
    const c = await company();
    const box = await c.machine(c.ceo, 'dev-mac');
    expect((await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test' })).error).toBe(false);
    const part = await nextOf(box.node, 'tests.run');
    const { call } = await orchestrator(c);

    const found = await call('find_tool', { query: 'stop test run' });
    expect(found.text).toContain('stop_tests: Stops a test run');
    const loaded = JSON.parse((await call('find_tool', { name: 'stop_tests' })).text);
    expect(loaded).toMatchObject({ name: 'stop_tests', description: expect.stringContaining('Stops a test run'), inputSchema: { properties: { run: { type: 'integer' } }, required: ['run'] } });

    expect(await call('use_tool', { name: 'stop_tests', arguments: { run: 1 } })).toEqual({ text: 'Test run 1 is stopped.', error: false });
    expect(await nextOf(box.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: part.partId });
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 was stopped by Orchestrator/);
  });

  it('says what a call lacks, and which tools there are when the name is wrong', async () => {
    const c = await company();
    const { call } = await orchestrator(c);
    const wrong = await call('use_tool', { name: 'stop_test', arguments: { run: 1 } });
    expect(wrong.error).toBe(true);
    expect(wrong.text).toContain('stop_tests');
    const bad = await call('use_tool', { name: 'stop_tests', arguments: { run: 'one' } });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain('run');
  });

  it("runs a tool of a department's own for the department it names, and without one names the departments", async () => {
    const c = await company();
    const { call } = await orchestrator(c);

    const none = await call('use_tool', { name: 'change_department', arguments: { about: 'Builds the shop.' } });
    expect(none.error).toBe(true);
    expect(none.text).toContain(`${c.dev.id} Development`);
    expect(none.text).toContain(`${c.sales.id} Sales`);
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.about).toBe('');

    expect((await call('use_tool', { name: 'change_department', department: c.dev.id, arguments: { about: 'Builds the shop.' } })).error).toBe(false);
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.about).toBe('Builds the shop.');
  });

  it("sets a worker's assignment and reads the briefing in the department it names", async () => {
    const c = await company();
    const { call } = await orchestrator(c);
    const set = await call('use_tool', { name: 'set_employee_assignment', department: c.dev.id, arguments: { employee: c.bruno.id, assignment: 'Owns checkout.' } });
    expect(set.error).toBe(false);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.bruno.id)))[0]!.overrides.base).toBe('Owns checkout.');
    expect((await call('use_tool', { name: 'set_employee_assignment', department: c.sales.id, arguments: { employee: c.bruno.id, assignment: 'Sells.' } })).error).toBe(true);
    expect((await call('use_tool', { name: 'briefing', department: c.dev.id })).text).toContain('https://github.com/acme/shop.git');
  });

  it('calls any route of the API as the owner, one that refused it too', async () => {
    const c = await company();
    const { call } = await orchestrator(c);
    const maria = await invitePerson(c.app, c.ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const id = (await c.app.inject({ url: '/api/me', ...as(maria) })).json().person.id as string;

    const made = await call('api', { method: 'PUT', path: `/api/people/${id}/ceo-delegate`, body: { isCeoDelegate: true } });
    expect(made.error).toBe(false);
    expect((await c.db.select().from(people).where(eq(people.id, id)))[0]!.isCeoDelegate).toBe(true);
    expect(JSON.parse((await call('api', { path: '/api/people' })).text).people).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Maria' })]));
  });

  it("answers a decision itself as the owner's answer, and people see that the orchestrator gave it for the owner", async () => {
    const c = await company();
    const { me, call } = await orchestrator(c);
    const owner = (await c.app.inject({ url: '/api/me', ...as(c.ceo) })).json().person.id as string;
    const { request } = await ask(c.app.ctx, c.bruno.id, c.task.id, { kind: 'question', text: 'Is tax in scope?' });

    expect((await call('api', { method: 'POST', path: `/api/requests/${request.id}`, body: { answer: 'Yes, with tax.' } })).error).toBe(false);
    expect((await c.db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'answered', answeredBy: owner, answeredByAgentId: me.id });
    const { task } = (await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.ceo) })).json() as { task: { requests: unknown[]; log: { kind: string; by: unknown }[] } };
    expect(task.requests).toMatchObject([{ id: request.id, answer: 'Yes, with tax.', byOrchestrator: true }]);
    /* Every tool call of the orchestrator keeps its job as a standing decision for the owner, so the log names the
       orchestrator and the owner it answered for. */
    expect(task.log.find(line => line.kind === 'answered')!.by).toMatchObject({ kind: 'agent', id: me.id, for: { id: owner } });
  });

  it("is refused no screen of a person's own: Google Sheets, a Telegram bot, who a person is in Telegram, the owner's key", async () => {
    const c = await company();
    const { call } = await orchestrator(c);
    const maria = await invitePerson(c.app, c.ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const id = (await c.app.inject({ url: '/api/me', ...as(maria) })).json().person.id as string;

    expect(await call('api', { path: '/api/google-sheets' })).toEqual({ text: '{"google":null}', error: false });
    expect((await call('api', { method: 'DELETE', path: `/api/agents/${c.head.id}/telegram` })).error).toBe(false);
    expect((await call('api', { method: 'PATCH', path: `/api/people/${id}`, body: { telegram: '@maria' } })).error).toBe(false);
    expect((await c.db.select().from(people).where(eq(people.id, id)))[0]!.telegramUsername).toBe('maria');
    expect(await call('api', { path: '/api/me/key' })).toEqual({ text: '{"key":null}', error: false });
  });
});
