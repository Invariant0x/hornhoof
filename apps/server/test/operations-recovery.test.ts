import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { encryptSecret } from '../src/crypto/secrets.js';
import { agentEvents, agents, jobs, subscriptions, taskEvents, tasks, type AgentKind } from '../src/db/schema.js';
import { placeOf, renderInstructions } from '../src/modules/agents/instructions.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { stopEmployeeTurn } from '../src/modules/program-operator/stop.js';
import { registerWatchTools } from '../src/modules/tools/watch.js';
import { operatorCompany } from './program-operator-company.js';

/* A turn that stands is Operations' own to end, the orchestrator's and every head's too, with no person asked and in any
   turn of theirs: the head of Operations and the program operator stop it, as Esc in its window does, or restart its program
   in the same session. Nobody else of the company may, and no call from outside the company reaches it. */

type Caller = { id: string; companyId: string; agentId: string; agentKind: AgentKind; roleKey: string | null };
type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
type Agent = typeof agents.$inferSelect;

async function staged() {
  const c = await operatorCompany(true);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [opsHead] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Olga', kind: 'head', roleKey: 'OPS-HEAD', departmentId: c.ops.id, subscriptionId: c.sub.id, model: '' }).returning();
  const [misnamed] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Mimi', kind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE, departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  await c.db.update(agents).set({ subscriptionId: c.sub.id }).where(eq(agents.id, orchestrator!.id));
  /* A turn of its own that no person answers: no person created it and none wrote into it. */
  const turn = async (agent: Agent): Promise<Caller> => {
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running', createdBy: null }).returning();
    return { id: job!.id, companyId: c.companyId, agentId: agent.id, agentKind: agent.kind, roleKey: agent.roleKey };
  };
  /* The turn that stands, with no machine to tell: Hornhoof ends it at once. */
  const standing = async (agent: Agent) => (await c.db.insert(jobs).values({ companyId: c.companyId, agentId: agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Stuck.', timeoutMs: 1000, status: 'running' }).returning())[0]!;
  const tools = (caller: Caller) => {
    const registered = vi.fn();
    registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, caller, new Set());
    const names = registered.mock.calls.map(([name]) => name as string);
    const call = (name: string, input: unknown) => (registered.mock.calls.find(([tool]) => tool === name)![2] as (input: unknown) => Promise<Reply>)(input);
    return { names, call };
  };
  const statusOf = async (id: string) => (await c.db.select({ status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, id)))[0]!;
  /* What was said in the turn; how it ended is a separate event. */
  const log = async (id: string) => (await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, id), eq(agentEvents.kind, 'message')))).map(e => e.data as { text: string; by?: string; operatorStop?: Record<string, unknown> });
  return { ...c, orchestrator: orchestrator!, opsHead: opsHead!, misnamed: misnamed!, turn, standing, tools, statusOf, log };
}

describe('Operations stop a turn that stands', () => {
  it('the head of Operations and the program operator stop the orchestrator and the head of another department, with no person asked, and say who stopped whom and why', async () => {
    const c = await staged();
    const olga = await c.turn(c.opsHead);
    const operator = await c.turn(c.operator!);
    const orchestratorTurn = await c.standing(c.orchestrator);
    const headTurn = await c.standing(c.head);
    expect(c.tools(olga).names).toEqual(expect.arrayContaining(['stop_employee', 'program_screen', 'program_keys', 'program_recovery_release', 'restart_program']));
    expect(c.tools(operator).names).toEqual(expect.arrayContaining(['stop_employee', 'program_screen', 'program_keys', 'program_recovery_release', 'restart_program']));

    const stopped = await c.tools(olga).call('stop_employee', { employee: c.orchestrator.id, reason: 'Its turn stands with 27 messages behind it.' });
    expect(stopped.isError).toBeFalsy();
    expect(JSON.parse(stopped.content[0]!.text!)).toMatchObject({ result: 'stopped', employee: c.orchestrator.id, job: orchestratorTurn.id });
    expect(await c.statusOf(orchestratorTurn.id)).toEqual({ status: 'failed', error: 'cancelled' });
    expect(await c.log(orchestratorTurn.id)).toEqual([expect.objectContaining({
      text: `Olga stopped the turn of ${c.orchestrator.name}. Reason: Its turn stands with 27 messages behind it.`,
      by: c.opsHead.id,
      operatorStop: expect.objectContaining({ actor: expect.objectContaining({ id: c.opsHead.id, name: 'Olga' }), employee: { id: c.orchestrator.id, name: c.orchestrator.name }, job: orchestratorTurn.id, operatorJobId: olga.id }),
    })]);

    const behind = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: 'Next.', createdBy: null, message: { personId: null, text: 'Next.', from: 'agent', by: c.agent.id, name: c.agent.name } });
    expect((await c.statusOf(behind)).status).toBe('queued');
    expect(await stopEmployeeTurn(c.ctx, operator, { employee: c.head.id, reason: 'Hana stands on a dead program.' })).toMatchObject({ result: 'stopped', employee: c.head.id, job: headTurn.id });
    expect(await c.statusOf(headTurn.id)).toEqual({ status: 'failed', error: 'cancelled' });
    expect((await c.statusOf(behind)).status, 'the queue behind the stopped turn moves').toBe('running');
    expect((await c.log(headTurn.id))[0]).toMatchObject({ text: 'Operator stopped the turn of Hana. Reason: Hana stands on a dead program.', by: c.operator!.id });
  });

  it('is refused to a worker, the head of another department, a program operator outside Operations, a turn that ended and a call from another company', async () => {
    const c = await staged();
    const target = await c.standing(c.orchestrator);
    const olga = await c.turn(c.opsHead);
    const ended = await c.turn(c.operator!);
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, ended.id));
    const refused = [await c.turn(c.agent), await c.turn(c.head), await c.turn(c.misnamed), ended, { ...olga, companyId: randomUUID() }];
    for (const caller of refused) await expect(stopEmployeeTurn(c.ctx, caller, { employee: c.orchestrator.id, reason: 'Stuck.' })).rejects.toMatchObject({ status: 403 });
    for (const caller of refused.slice(0, 2)) expect(c.tools(caller).names).not.toContain('stop_employee');
    expect(await c.statusOf(target.id)).toEqual({ status: 'running', error: null });
    expect(await c.log(target.id)).toEqual([]);
  });

  it('keeps a secret named in the reason out of both logs', async () => {
    const c = await staged();
    const secret = 'sk-live-0123456789abcdef';
    await c.db.update(subscriptions).set({ secretEnc: encryptSecret(secret, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 7, title: 'Plan', status: 'working', assigneeAgentId: c.head.id, executorAgentId: c.head.id }).returning();
    const target = await c.standing(c.head);
    await c.db.update(jobs).set({ taskId: task!.id }).where(eq(jobs.id, target.id));
    await stopEmployeeTurn(c.ctx, await c.turn(c.opsHead), { employee: c.head.id, reason: `It stands on the key ${secret} it was shown.` });
    const said = JSON.stringify([await c.log(target.id), await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, task!.id))]);
    expect(said).not.toContain(secret);
    expect(said).toContain('Olga stopped the turn of Hana. Reason: It stands on the key [hidden] it was shown.');
  });

  it("leaves a person's own assistant to its owner", async () => {
    const c = await staged();
    const [assistant] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', model: '', name: 'Ava', subscriptionId: c.sub.id }).returning();
    const own = await c.standing(assistant!);
    await expect(stopEmployeeTurn(c.ctx, await c.turn(c.opsHead), { employee: assistant!.id, reason: 'Stuck.' })).rejects.toMatchObject({ status: 403 });
    expect(await c.statusOf(own.id)).toEqual({ status: 'running', error: null });
    expect(await c.log(own.id)).toEqual([]);
  });

  it('says nothing runs when the employee runs no turn, and never stops the caller itself', async () => {
    const c = await staged();
    const olga = await c.turn(c.opsHead);
    await expect(stopEmployeeTurn(c.ctx, olga, { employee: c.head.id, reason: 'Stuck.' })).rejects.toMatchObject({ status: 409, reason: 'nothing_running' });
    await expect(stopEmployeeTurn(c.ctx, olga, { employee: c.opsHead.id, reason: 'Stuck.' })).rejects.toMatchObject({ status: 403 });
    expect(await c.statusOf(olga.id)).toEqual({ status: 'running', error: null });
  });
});

describe('Operations restart a program that stands', () => {
  it('goes by role only inside Operations: a program operator placed elsewhere and a call from another company are refused before the node hears of it', async () => {
    const c = await staged();
    await c.standing(c.head);
    const refused = [await c.turn(c.misnamed), { ...(await c.turn(c.opsHead)), companyId: randomUUID() }];
    for (const caller of refused) {
      const res = await c.tools(caller).call('restart_program', { employee: c.head.id });
      expect(res).toMatchObject({ isError: true, content: [{ text: "Only the orchestrator and Operations look at another employee's program and type into it." }] });
    }
    expect(c.sent.mock.calls.filter(([, frame]) => (frame as { type: string }).type === 'agent.restart')).toEqual([]);
    expect(c.tools(await c.turn(c.agent)).names).not.toContain('restart_program');
    expect(c.tools(await c.turn(c.head)).names).not.toContain('restart_program');
  });
});

describe('what Operations are told', () => {
  it('reaches a head of Operations hired before the program skill was in its role, and the program operator, with every turn', async () => {
    const c = await staged();
    await c.db.update(agents).set({ skills: ['ops-work-pipeline', 'ops-intake'], overrides: { skills: { 'ops-program-operator': 'An old text of its own.' } } }).where(eq(agents.id, c.opsHead.id));
    for (const id of [c.opsHead.id, c.operator!.id]) {
      const [agent] = await c.db.select().from(agents).where(eq(agents.id, id));
      const told = renderInstructions(c.ctx.templates, agent!, await placeOf(c.db, agent!)).raw;
      expect(told, agent!.roleKey!).toContain('stop_employee');
      expect(told, agent!.roleKey!).toMatch(/never ask a person to stop a turn/i);
      expect(told, agent!.roleKey!).not.toContain('An old text of its own.');
    }
    const role = c.ctx.templates.roles.get('OPS-HEAD')!;
    expect(role.skills.find(s => s.id === 'ops-program-operator')).toEqual({ id: 'ops-program-operator', on: true, locked: true });
  });
});
