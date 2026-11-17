import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentChanges, agentEvents, agents, approvalPolicies, departments, jobs, teams } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { appendEvent } from '../src/modules/events/store.js';
import { company } from './department-owner-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';

/* The first copy of the shared database opens as the file is collected: a cold open is no part of the first test's time. */
await prepareSharedDatabase();

/* A department runs itself: what a person who runs it decides in its head's window, its head carries out at once, as that
   person, with no word of the orchestrator or the CEO. Nothing outside the department comes with it. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const ok = (r: Res) => expect(r.isError, text(r)).toBeFalsy();
const OUTSIDE = 'You change only your own department';

const HEAD_TOOLS = ['staffing_options', 'hire', 'change_department', 'set_team_urgent_only', 'change_employee', 'reset_employee', 'fire_employee'];

const teamNames = async (c: C) => (await c.db.select(only(teams, 'name')).from(teams).where(eq(teams.departmentId, c.dev.id))).map(t => t.name).sort();
const productNames = async (c: C) => (await c.db.select(only(departments, 'name')).from(departments).where(eq(departments.parentId, c.dev.id))).map(d => d.name).sort();
const agentRow = async (c: C, id: string) => (await c.db.select().from(agents).where(eq(agents.id, id)))[0]!;

describe("a department head's tools", () => {
  it('run its own department, and no worker has them', async () => {
    const c = await company();
    const names = async (agent: { id: string }) => (await (await c.tools(agent)).listTools()).tools.map(t => t.name);
    const head = await names(c.head);
    expect(head).toEqual(expect.arrayContaining(HEAD_TOOLS));
    for (const name of ['build_structure', 'api', 'invite_person', 'change_person', 'set_repository']) expect(head, name).not.toContain(name);
    const worker = await names(c.worker);
    for (const name of HEAD_TOOLS) expect(worker, name).not.toContain(name);
  });
});

describe('a department head for a person who runs its department', () => {
  it('creates, renames and removes sub-units and adds and removes products of its department', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hana = await c.tools(c.head);
    ok(await call(hana, 'change_department', { teams: ['Mobile', 'Web'], products: ['App'] }));
    expect(await teamNames(c)).toEqual(['Mobile', 'Web']);
    expect(await productNames(c)).toEqual(['App', 'Shop']);
    const [mobile, web] = await c.db.select().from(teams).where(and(eq(teams.departmentId, c.dev.id), inArray(teams.name, ['Mobile', 'Web']))).orderBy(teams.name);
    ok(await call(hana, 'change_department', { teams: [{ id: mobile!.id, name: 'Apps' }, { id: web!.id, remove: true }], removeProducts: [c.product.id] }));
    expect(await teamNames(c)).toEqual(['Apps']);
    expect(await productNames(c)).toEqual(['App']);
    ok(await call(hana, 'set_team_urgent_only', { team: mobile!.id, urgentOnly: true }));
    expect((await c.db.select().from(teams).where(eq(teams.id, mobile!.id)))[0]!.urgentOnly).toBe(true);
  });

  it('hires into its department and changes, resets and fires its employees, each kept as that person\'s decision', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hana = await c.tools(c.head);
    const options = JSON.parse(text(await call(hana, 'staffing_options', {}))) as { department: { id: string } };
    expect(options.department.id).toBe(c.dev.id);
    ok(await call(hana, 'hire', { people: [{ role: 'DEV-BE', name: 'Ira' }] }));
    const [ira] = await c.db.select().from(agents).where(and(eq(agents.departmentId, c.dev.id), eq(agents.name, 'Ira'), isNull(agents.removedAt)));
    expect(ira).toBeDefined();
    const [web] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Web' }).returning();
    ok(await call(hana, 'change_employee', { employee: c.worker.id, name: 'Bob', team: web!.id }));
    expect(await agentRow(c, c.worker.id)).toMatchObject({ name: 'Bob', teamId: web!.id });
    ok(await call(hana, 'reset_employee', { employee: c.worker.id }));
    ok(await call(hana, 'fire_employee', { employee: ira!.id }));
    expect((await agentRow(c, ira!.id)).removedAt).not.toBeNull();
    const changes = await c.db.select().from(agentChanges).where(inArray(agentChanges.agentId, [c.worker.id, ira!.id]));
    expect(changes.map(ch => ch.field).sort()).toEqual(['hired', 'name', 'removed', 'reset', 'team']);
    for (const change of changes) expect(change, change.field).toMatchObject({ personId: c.ids.dana, byOrchestrator: false });
    const applied = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.head.id), eq(agentEvents.kind, 'applied')));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ personId: null, data: { kind: 'staff', department: c.dev.id, onBehalfOfPersonId: c.ids.dana, sourceSeq: null } });
  });

  it('moves an employee who holds work into an urgent-only sub-unit', async () => {
    const c = await company();
    const hana = await c.tools(c.head);
    const [rush] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Rush', urgentOnly: true }).returning();
    ok(await call(hana, 'change_employee', { employee: c.worker.id, team: rush!.id }));
    expect((await agentRow(c, c.worker.id)).teamId).toBe(rush!.id);
  });

  it('uses its named owner without a fresh message, and records the head and whose rights it used', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hana = await c.tools(c.head);
    ok(await call(hana, 'change_department', { teams: ['Mobile'] }));
    ok(await call(hana, 'set_approval_policy', { department: c.dev.id, channel: 'message', mode: 'every' }));
    const [policy] = await c.db.select().from(approvalPolicies).where(eq(approvalPolicies.departmentId, c.dev.id));
    expect(policy).toMatchObject({ updatedBy: c.ids.dana, mode: 'every' });
    const applied = await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ agentId: c.head.id, personId: null, data: { onBehalfOfPersonId: c.ids.dana, sourceSeq: null } });
    expect(await teamNames(c)).toEqual(['Mobile']);
  });

  it('keeps the orchestrator\'s own department and staffing changes in its own history', async () => {
    const c = await company();
    const orchestrator = await c.tools(c.orchestrator);
    ok(await call(orchestrator, 'build_structure', { items: [{ department: c.dev.id, teams: ['Mobile'] }] }));
    ok(await call(orchestrator, 'hire', { department: c.dev.id, people: [{ role: 'DEV-BE', name: 'Ira' }] }));
    const applied = await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'));
    expect(applied).toHaveLength(2);
    for (const event of applied) expect(event).toMatchObject({ agentId: c.orchestrator.id, personId: null, data: { onBehalfOfPersonId: c.ids.ceo, sourceSeq: null } });
    expect(applied.some(event => event.data.kind === 'staff')).toBe(true);
    expect(await teamNames(c)).toEqual(['Mobile']);
  });

  it('keeps its own owner when another person, assistant or employee writes into the turn', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    const hana = await c.tools(c.head, c.ids.sam);
    const [turn] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'running')));
    await appendEvent(c.app.ctx, {
      companyId: c.companyId, agentId: c.head.id, jobId: turn!.id, kind: 'message', personId: c.ids.ceo,
      data: { text: 'Make a Mobile sub-unit.', channel: 'assistant', assistant: { id: randomUUID(), name: 'Ava', message: randomUUID() } },
    });
    await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.head.id, jobId: turn!.id, kind: 'message', personId: null, data: { text: 'Please hire me a helper.', from: 'agent', name: 'Bruno', by: c.worker.id } });
    ok(await call(hana, 'change_employee', { employee: c.worker.id, name: 'Bob' }));
    const [change] = await c.db.select().from(agentChanges).where(eq(agentChanges.agentId, c.worker.id));
    expect(change).toMatchObject({ personId: c.ids.dana, byOrchestrator: false });
  });
});

describe('a department head refuses', () => {
  it('uses the active CEO when no department owner is named, whoever opened the turn', async () => {
    const c = await company();
    for (const by of [null, c.ids.sam, c.ids.wes]) {
      const hana = await c.tools(c.head, by);
      ok(await call(hana, 'change_employee', { employee: c.worker.id, name: `Bob ${by ?? 'alone'}` }));
    }
    const changes = await c.db.select().from(agentChanges).where(eq(agentChanges.agentId, c.worker.id));
    expect(changes).toHaveLength(3);
    for (const change of changes) expect(change).toMatchObject({ personId: c.ids.ceo, byOrchestrator: false });
  });

  it('anything outside its own department, even on the CEO\'s word', async () => {
    const c = await company();
    const hana = await c.tools(c.head, c.ids.ceo);
    const [field] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.sales.id, name: 'Field' }).returning();
    for (const [name, args] of [
      ['change_employee', { employee: c.seller.id, name: 'Sidney' }],
      ['reset_employee', { employee: c.seller.id }],
      ['fire_employee', { employee: c.seller.id }],
      ['change_employee', { employee: c.orchestrator.id, model: '' }],
      ['change_department', { removeProducts: [c.dev.id] }],
      ['change_department', { removeProducts: [c.sales.id] }],
      ['set_team_urgent_only', { team: field!.id, urgentOnly: true }],
    ] as const) {
      const refused = await call(hana, name, args);
      expect(refused.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(refused), name).toContain(OUTSIDE);
    }
    expect(await agentRow(c, c.seller.id)).toMatchObject({ name: 'Sid', removedAt: null });
    expect((await c.db.select().from(departments).where(inArray(departments.id, [c.dev.id, c.sales.id]))).length).toBe(2);
    expect((await c.db.select().from(teams).where(eq(teams.id, field!.id)))[0]!.urgentOnly).toBe(false);
  });
});
