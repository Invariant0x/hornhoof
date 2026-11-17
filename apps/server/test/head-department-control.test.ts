import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentChanges, agents, departments, jobs, teams } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { appendEvent } from '../src/modules/events/store.js';
import { company } from './department-owner-fixture.js';

/* A department runs itself: what a person who runs it decides in its head's window, its head carries out at once, as that
   person, with no word of the orchestrator or the CEO. Nothing outside the department comes with it. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const ok = (r: Res) => expect(r.isError, text(r)).toBeFalsy();
const THEIRS = 'Only the people of this department decide this';
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
    for (const name of ['build_structure', 'view', 'invite_person', 'change_person', 'set_repository']) expect(head, name).not.toContain(name);
    const worker = await names(c.worker);
    for (const name of HEAD_TOOLS) expect(worker, name).not.toContain(name);
  });
});

describe('a department head for a person who runs its department', () => {
  it('creates, renames and removes sub-units and adds and removes products of its department', async () => {
    const c = await company();
    const hana = await c.tools(c.head, c.ids.dana);
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
    const hana = await c.tools(c.head, c.ids.dana);
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
  });

  it('moves an employee who holds work into an urgent-only sub-unit', async () => {
    const c = await company();
    const hana = await c.tools(c.head, c.ids.dana);
    const [rush] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Rush', urgentOnly: true }).returning();
    ok(await call(hana, 'change_employee', { employee: c.worker.id, team: rush!.id }));
    expect((await agentRow(c, c.worker.id)).teamId).toBe(rush!.id);
  });

  it('goes by the last person who wrote into its turn, also through their assistant', async () => {
    const c = await company();
    const hana = await c.tools(c.head);
    const refused = await call(hana, 'change_department', { teams: ['Mobile'] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(THEIRS);
    const [turn] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'running')));
    await appendEvent(c.app.ctx, {
      companyId: c.companyId, agentId: c.head.id, jobId: turn!.id, kind: 'message', personId: c.ids.dana,
      data: { text: 'Make a Mobile sub-unit.', channel: 'assistant', assistant: { id: randomUUID(), name: 'Ava', message: randomUUID() } },
    });
    ok(await call(hana, 'change_department', { teams: ['Mobile'] }));
    await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.head.id, jobId: turn!.id, kind: 'message', personId: null, data: { text: 'Please hire me a helper.', from: 'agent', name: 'Bruno', by: c.worker.id } });
    ok(await call(hana, 'change_department', { teams: ['Web'] }));
    expect(await teamNames(c)).toEqual(['Mobile', 'Web']);
  });
});

describe('a department head refuses', () => {
  it('in a turn that answers nobody, or someone who does not run its department, and changes nothing', async () => {
    const c = await company();
    for (const by of [null, c.ids.sam, c.ids.wes]) {
      const hana = await c.tools(c.head, by);
      for (const [name, args] of [
        ['change_department', { teams: ['Mobile'] }],
        ['hire', { people: [{ role: 'DEV-BE', name: 'Ira' }] }],
        ['change_employee', { employee: c.worker.id, name: 'Bob' }],
        ['fire_employee', { employee: c.worker.id }],
      ] as const) {
        const refused = await call(hana, name, args);
        expect(refused.isError, `${name} for ${by}`).toBe(true);
        expect(text(refused), `${name} for ${by}`).toContain(THEIRS);
      }
    }
    expect(await teamNames(c)).toEqual([]);
    expect(await agentRow(c, c.worker.id)).toMatchObject({ name: 'Bruno', removedAt: null });
    expect(await c.db.select().from(agents).where(eq(agents.name, 'Ira'))).toEqual([]);
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
