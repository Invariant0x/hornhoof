import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, proposals, requests, subscriptions } from '../src/db/schema.js';
import { computerPrincipal, decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { appendEvent } from '../src/modules/events/store.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

const TOKEN = 'tool-token-assistant-0123456789abcdef';
type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (r: Result) => r.content[0]!.text;

/* Acme with Development, its head Hana and Bruno, and the orchestrator's running turn, which nobody wrote into yet. */
async function company() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [ivan] = await db.select().from(people).where(eq(people.isOwner, true));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const [job] = await db
    .insert(jobs)
    .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) })
    .returning();
  const { task } = await createTask(ctx, { agentId: hana.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true });
  /* The CEO's words into the orchestrator's turn: their own, or written for them by their assistant. */
  const wrote = async (text: string, byAssistant = false) =>
    (await appendEvent(ctx, {
      companyId: acme!.id, agentId: orchestrator!.id, jobId: job!.id, kind: 'message', personId: ivan!.id,
      data: { text, ...(byAssistant ? { channel: 'assistant', assistant: { id: randomUUID(), name: 'Ava', message: randomUUID() } } : {}) },
    })).seq;
  const asking = async (q: Parameters<typeof ask>[3]) => (await ask(ctx, bruno.id, task.id, q)).request;
  return { app, db, acme: acme!, orchestrator: orchestrator!, ivan: ivan!, dev: dev!, bruno, job: job!, wrote, asking };
}

describe("the orchestrator on an assistant's word", () => {
  it('administers nothing, and does once the person writes themselves', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'QA.', items: [] }).returning();
    await c.wrote('Invite Pia, hire the QA and rename Bruno.', true);

    const invited = await call(client, 'invite_person', { name: 'Pia', email: 'pia@acme.com', title: '', access: { whole: true } });
    expect(invited.isError).toBe(true);
    expect(text(invited)).toContain("never administered on an assistant's word");
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    expect((await call(client, 'build_structure', { items: [{ template: 'design', note: 'Screens.' }] })).isError).toBe(true);
    expect((await call(client, 'set_department_owner', { department: c.dev.id, person: c.ivan.id })).isError).toBe(true);
    await call(client, 'database', { sql: `UPDATE agents SET name = 'Bruno Diaz' WHERE id = '${c.bruno.id}'` });
    expect((await c.db.select().from(agents).where(eq(agents.id, c.bruno.id)))[0]!.name).toBe('Bruno');
    expect(await c.db.select().from(people).where(eq(people.email, 'pia@acme.com'))).toEqual([]);
    expect(await computerPrincipal(c.db, c.job.id)).toBeNull();
    expect(await decisionPrincipal(c.db, c.job.id)).toMatchObject({ personId: c.ivan.id, byAssistant: true });

    await c.wrote('Yes, invite Pia.');
    expect((await call(client, 'invite_person', { name: 'Pia', email: 'pia@acme.com', title: '', access: { whole: true } })).isError).toBeFalsy();
    expect(await computerPrincipal(c.db, c.job.id)).toBe(c.ivan.id);
  });

  it('answers a request about work for the person, never one about administering the company', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const work = await c.asking({ kind: 'question', text: 'Which payment provider?', topic: 'task' });
    const machine = await c.asking({ kind: 'question', text: 'May I use the Mac mini?', topic: 'machines' });
    await c.wrote('Stripe, and yes to the Mac mini.', true);
    const refused = await call(client, 'answer_request', { request: machine.id, answer: 'Yes.' });
    expect(refused.isError).toBe(true);
    expect((await c.db.select().from(requests).where(eq(requests.id, machine.id)))[0]!.status).toBe('open');
    expect((await call(client, 'answer_request', { request: work.id, answer: 'Stripe.' })).isError).toBeFalsy();
    expect((await c.db.select().from(requests).where(eq(requests.id, work.id)))[0]).toMatchObject({ status: 'answered', answeredBy: c.ivan.id });
  });
});
