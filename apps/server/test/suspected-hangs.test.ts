import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs, requests, subscriptions, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { suspectedHangs } from '../src/modules/tasks/suspected-hangs.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import type { Grant } from '../src/modules/templates/load.js';
import { jobOf } from '../src/modules/tools/job.js';
import { registerWatchTools } from '../src/modules/tools/watch.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';
import { developmentStages } from './templates-once.js';

const MIN = 60_000;
/* The clock only the test moves: every row, report and look at the list is stamped with it. */
const START = new Date('2030-01-01T08:00:00Z');

type Company = Awaited<ReturnType<typeof company>>;
type Agent = typeof agents.$inferSelect;
type Result = { content: { text: string }[]; isError?: boolean };

async function company() {
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  onTestFinished(() => { vi.useRealTimers(); });
  const c = await failureCompany();
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const iso = (at: number) => new Date(at).toISOString();
  let seq = 0;

  /* A task in work that the agent holds, with a turn on it that the node began just now. */
  async function work(agent: Agent, number: number, fields: Partial<typeof tasks.$inferInsert> = {}) {
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number, title: `Task ${number}`, status: 'working', assigneeAgentId: agent.id, executorAgentId: agent.id, ...fields }).returning();
    await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
    const turn = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: agent.id, taskId: task!.id, prompt: 'Work', createdBy: null, message: { personId: null, text: 'Work', taskWake } });
    await c.db.update(jobs).set({ sessionId: 'session' }).where(eq(jobs.id, turn));
    return { task: task!, turn };
  }
  /* A turn of the agent that is on no task. */
  async function chat(agent: Agent) {
    const turn = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: agent.id, prompt: 'Hello.', createdBy: null });
    await c.db.update(jobs).set({ sessionId: 'session' }).where(eq(jobs.id, turn));
    return turn;
  }
  /* The node says what the turn's program does, as it does at least once a minute: since when it is in that state, when its
     screen last changed, and its last sign of work. */
  const report = (turn: string, state: 'thinking' | 'tool' | 'idle' | 'gone' = 'thinking', at: { since?: number; screenAt?: number; signAt?: number; tool?: string } = {}) =>
    handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: turn, state, since: at.since ?? Date.now(), screenAt: at.screenAt ?? Date.now(), signAt: at.signAt ?? Date.now(), ...(at.tool ? { tool: at.tool } : {}) });
  /* What the turn's program streams through its node: a line of its answer. */
  const said = (turn: string) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.event', jobId: turn, seq: seq++, event: { kind: 'text', text: 'Step.' } });
  /* The turn's program calls a Hornhoof tool with the turn's token, as its MCP bridge does. */
  const called = async (turn: string) => {
    const token = `token-${turn}`;
    await c.db.update(jobs).set({ toolTokenHash: hashToken(token) }).where(eq(jobs.id, turn));
    await jobOf(c.ctx, { headers: { authorization: `Bearer ${token}` } } as FastifyRequest);
  };
  const ends = (turn: string) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: turn, ok: true, sessionId: 'session', result: 'Done.', tail: '' });
  const list = () => suspectedHangs(c.ctx, c.companyId, new Date());
  const names = async () => (await list()).map(h => h.agent);
  return { ...c, later, iso, work, chat, report, said, called, ends, list, names };
}

describe('the suspected hang list', () => {
  it('lists a turn once it has been silent for 10 minutes while a task is on its agent', async () => {
    const c = await company();
    const { task, turn } = await c.work(c.agent, 1);
    await c.report(turn);
    c.later(10 * MIN - 1);
    expect(await c.list()).toEqual([]);

    c.later(1);
    const [hang] = await c.list();
    expect(hang).toMatchObject({ agentId: c.agent.id, agent: 'Bruno', turnId: turn, task: { id: task.id, number: 1, title: 'Task 1' }, silentMs: 10 * MIN, lastSign: { at: c.iso(START.getTime()), kind: 'program_sign' } });
    expect(await c.list()).toHaveLength(1);
  });

  it('says how long the turn has been silent and what its last sign was', async () => {
    const c = await company();
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn);
    c.later(4 * MIN);
    await c.said(turn);
    c.later(17 * MIN);
    expect(await c.list()).toMatchObject([{ silentMs: 17 * MIN, lastSign: { at: c.iso(START.getTime() + 4 * MIN), kind: 'event' } }]);
  });

  it.each(['claude', 'codex', 'kimi', 'antigravity'] as const)('lists a silent %s turn the same way', async provider => {
    const c = await company();
    await c.db.update(subscriptions).set({ provider }).where(eq(subscriptions.id, c.sub.id));
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn);
    c.later(10 * MIN);
    expect(await c.names()).toEqual(['Bruno']);
  });

  it('counts a redraw of the screen as no sign, as every program animates one while it hangs', async () => {
    const c = await company();
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn);
    for (let i = 0; i < 6; i++) {
      c.later(2 * MIN);
      await c.report(turn, 'thinking', { since: START.getTime(), signAt: START.getTime() });
    }
    expect(await c.names()).toEqual(['Bruno']);
  });

  it('keeps out a turn whose running tool keeps changing, and lists the one whose tool went silent', async () => {
    const c = await company();
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn, 'tool', { since: Date.now(), tool: 'Bash' });
    c.later(8 * MIN);
    await c.report(turn, 'tool', { since: START.getTime(), signAt: Date.now(), tool: 'Bash' });
    c.later(9 * MIN);
    expect(await c.list()).toEqual([]);
    c.later(MIN);
    expect(await c.names()).toEqual(['Bruno']);
    expect(await c.list()).toMatchObject([{ program: { state: 'tool', tool: 'Bash' }, lastSign: { kind: 'program_sign' } }]);
  });

  it.each([
    ['a sign from the node', (c: Company, turn: string) => c.report(turn, 'thinking', { since: START.getTime() })],
    ['a streamed event', (c: Company, turn: string) => c.said(turn)],
    ['a call of a Hornhoof tool', (c: Company, turn: string) => c.called(turn)],
    ['a change of its program state', (c: Company, turn: string) => c.report(turn, 'tool', { signAt: START.getTime(), tool: 'Read' })],
  ] as const)('drops the entry by itself on %s', async (_, sign) => {
    const c = await company();
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn);
    c.later(10 * MIN);
    expect(await c.names()).toEqual(['Bruno']);

    await sign(c, turn);
    expect(await c.list()).toEqual([]);
    c.later(10 * MIN);
    expect(await c.names()).toEqual(['Bruno']);
  });

  it('drops the entry by itself when the turn ends', async () => {
    const c = await company();
    const { turn } = await c.work(c.agent, 1);
    await c.report(turn);
    c.later(25 * MIN);
    expect(await c.names()).toEqual(['Bruno']);

    await c.ends(turn);
    expect(await c.list()).toEqual([]);
  });

  describe('lists no turn whose silence is expected', () => {
    type Wait = (c: Company, task: typeof tasks.$inferSelect) => Promise<unknown>;
    const waits: [string, Wait, Wait][] = [
      ['waits for a person', (c, t) => c.db.insert(requests).values({ companyId: c.companyId, taskId: t.id, agentId: c.agent.id, kind: 'question', text: 'Which payment provider?' }),
        (c, t) => c.db.update(requests).set({ status: 'answered', answer: 'Stripe' }).where(eq(requests.taskId, t.id))],
      ['waits for an outside event', (c, t) => c.db.update(tasks).set({ externalWait: { reason: 'Waiting for the agreed event', since: c.iso(Date.now()), until: c.iso(Date.now() + 120 * MIN) } }).where(eq(tasks.id, t.id)),
        (c, t) => c.db.update(tasks).set({ externalWait: null }).where(eq(tasks.id, t.id))],
      ['waits for other tasks', async (c, t) => {
        const [first] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 9, title: 'First', status: 'working', assigneeAgentId: c.head.id }).returning();
        await c.db.update(tasks).set({ after: [first!.id] }).where(eq(tasks.id, t.id));
      }, (c, t) => c.db.update(tasks).set({ after: [] }).where(eq(tasks.id, t.id))],
      ['is paused', (c, t) => c.db.update(tasks).set({ paused: { at: c.iso(Date.now()), reason: 'Wait for the brand.', by: { agentId: c.head.id }, root: t.id } }).where(eq(tasks.id, t.id)),
        (c, t) => c.db.update(tasks).set({ paused: null }).where(eq(tasks.id, t.id))],
    ];

    it.each(waits)('when its task %s', async (_, wait, over) => {
      const c = await company();
      const { task, turn } = await c.work(c.agent, 1);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.names(), 'the same turn is listed while its task is in work').toEqual(['Bruno']);

      await wait(c, task);
      expect(await c.list()).toEqual([]);

      await over(c, task);
      expect(await c.names()).toEqual(['Bruno']);
    });

    it.each(['waiting', 'blocked', 'review'] as const)('when its task is %s', async status => {
      const c = await company();
      const { task, turn } = await c.work(c.agent, 1);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.names()).toEqual(['Bruno']);
      await c.db.update(tasks).set({ status }).where(eq(tasks.id, task.id));
      expect(await c.list()).toEqual([]);
    });

    it('when its machine is away, as nobody can look at its screen', async () => {
      const c = await company();
      const { turn } = await c.work(c.agent, 1);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.names()).toEqual(['Bruno']);
      vi.spyOn(c.ctx.hub, 'awaySince').mockReturnValue(Date.now() - 5 * MIN);
      expect(await c.list()).toEqual([]);
    });

    it('when its program was restarted less than 10 minutes ago', async () => {
      const c = await company();
      const { turn } = await c.work(c.agent, 1);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.names()).toEqual(['Bruno']);
      await c.db.update(jobs).set({ restartedAt: new Date() }).where(eq(jobs.id, turn));
      c.later(9 * MIN);
      expect(await c.list()).toEqual([]);
      c.later(MIN);
      expect(await c.list()).toMatchObject([{ lastSign: { kind: 'restart' } }]);
    });
  });

  describe('a turn that is on no task', () => {
    const holds = (c: Company, fields: Partial<typeof tasks.$inferInsert> = {}) =>
      c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', assigneeAgentId: c.agent.id, ...fields }).returning().then(([task]) => task!);

    it('is listed with the task in work its agent holds', async () => {
      const c = await company();
      const task = await holds(c);
      const turn = await c.chat(c.agent);
      await c.report(turn);
      c.later(10 * MIN);
      expect(await c.list()).toMatchObject([{ turnId: turn, task: { id: task.id, number: 1 } }]);
    });

    it('is not listed when the task its agent holds waits', async () => {
      const c = await company();
      await holds(c, { externalWait: { reason: 'Waiting for the agreed event', since: c.iso(Date.now()), until: c.iso(Date.now() + 120 * MIN) } });
      const turn = await c.chat(c.agent);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.list()).toEqual([]);
    });

    it('is not listed when its agent holds no task', async () => {
      const c = await company();
      const turn = await c.chat(c.agent);
      await c.report(turn);
      c.later(30 * MIN);
      expect(await c.list()).toEqual([]);
    });
  });

  describe('the tool Operations read in their round', () => {
    async function round(c: Company, grants: Grant[]) {
      const server = new McpServer({ name: 'test', version: '1' });
      const registered = vi.spyOn(server, 'registerTool');
      onTestFinished(() => server.close());
      registerWatchTools(server, c.ctx, { id: 'watcher-job', companyId: c.companyId, agentId: c.watcher.id, agentKind: 'worker' }, new Set<Grant>(grants));
      const entry = (registered.mock.calls as [string, unknown, unknown][]).find(([name]) => name === 'suspected_hangs');
      return entry ? async () => (await (entry[2] as () => Promise<Result>)()).content[0]!.text : null;
    }

    it('returns only the agents on the list, not the ones that work', async () => {
      const c = await company();
      const cora = await c.hire('Cora', 'worker', 'DEV-BE', c.dev.id);
      const idle = await c.work(c.agent, 1);
      const busy = await c.work(cora, 2);
      await c.report(idle.turn);
      await c.report(busy.turn);
      c.later(10 * MIN);
      await c.said(busy.turn);

      const read = await round(c, ['hangs']);
      expect(read, 'the hangs grant gives the suspected_hangs tool').not.toBeNull();
      const listed = JSON.parse(await read!()) as { agent: string; turnId: string; task: { number: number }; silentMs: number; lastSign: { kind: string } }[];
      expect(listed).toMatchObject([{ agent: 'Bruno', turnId: idle.turn, task: { number: 1 }, silentMs: 10 * MIN }]);
      expect(JSON.stringify(listed)).not.toContain('Cora');
    });

    it('returns an empty list when nothing hangs', async () => {
      const c = await company();
      const { turn } = await c.work(c.agent, 1);
      await c.report(turn);
      const read = await round(c, ['hangs']);
      expect(JSON.parse(await read!())).toEqual([]);
    });

    it('is given by the hangs grant alone', async () => {
      const c = await company();
      expect(await round(c, ['agents', 'failures', 'message_employee', 'restart_program'])).toBeNull();
    });
  });
});
