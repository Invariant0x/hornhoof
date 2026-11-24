import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, jobs, pendingWakes, taskEvents, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { checkExternalWaits } from '../src/modules/tasks/external-wait.js';
import { until } from './helpers.js';
import { company, done, nextOf } from './test-runs-company.js';

/* #2061 F1: a progress check of a run the server can see wakes nobody while the run goes on, since the run's end wakes its
   starter anyway. The check rides on the run, and the run's end ends it, so the result is the one turn the starter gets. */

type Company = Awaited<ReturnType<typeof company>>;

const RUN_TOOLS = [
  { tool: 'run_tests', args: { branch: 'main' }, name: 'Test run', why: 'tests' },
  { tool: 'run_work', args: { branch: 'main' }, name: 'Work run', why: 'work' },
] as const;

const MIN = 60_000;
const taskRow = async (c: Company) => (await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!;

/* The turns Bruno was given on the task since his own turn ended, and how often he was told of a run's end. */
async function toldOf(c: Company) {
  const turns = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.taskId, c.task.id), eq(jobs.status, 'queued')));
  const events = await c.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.agentId, c.bruno.id), eq(agentEvents.kind, 'message')));
  const news = events.filter(e => ['tests', 'work'].includes((e.data as { taskWake?: { why?: string } }).taskWake?.why ?? ''));
  return { prompts: turns.map(t => t.prompt), news: news.length };
}

/* Bruno, in a turn on the task, does what an agent does: starts something, records the check, and ends his turn. */
async function tracked(c: Company, start: (call: Awaited<ReturnType<Company['turn']>>['call']) => Promise<void>, minutes = 30) {
  const t = await c.turn(c.bruno);
  await start(t.call);
  const nextCheck = new Date(Date.now() + minutes * MIN).toISOString();
  const recorded = await t.call('track_work', { task: c.task.number, work: 'The run on the checkout', nextCheck });
  expect(recorded.error).toBe(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
  return new Date(nextCheck);
}

describe('a progress check of a run the server can see (#2061 F1)', () => {
  describe.each(RUN_TOOLS)('$tool', run => {
    it('moves on at its time without a turn while the run still goes, and says so in the log', async () => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      const due = await tracked(c, async call => expect((await call(run.tool, { command: 'make check', ...run.args })).error).toBe(false));
      const at = new Date(due.getTime() + MIN);

      expect(await checkExternalWaits(c.app.ctx, at)).toBe(0);

      const wait = (await taskRow(c)).externalWait;
      expect(wait).toMatchObject({ work: true, reason: 'The run on the checkout' });
      expect(new Date(wait!.until).getTime()).toBeGreaterThan(at.getTime());
      expect((await toldOf(c)).prompts).toEqual([]);
      expect(await c.db.select().from(pendingWakes).where(eq(pendingWakes.agentId, c.bruno.id))).toEqual([]);
      const log = await c.db.select(only(taskEvents, 'text')).from(taskEvents).where(eq(taskEvents.taskId, c.task.id));
      expect(log.map(e => e.text)).toContainEqual(expect.stringMatching(new RegExp(`${run.name} 1 still goes, so the check moved to `)));
      /* The same sweep again, or a later one before the moved time, wakes nobody either. */
      expect(await checkExternalWaits(c.app.ctx, at)).toBe(0);
      expect((await toldOf(c)).prompts).toEqual([]);
    });

    it('ends with the run: its end is the one turn its starter gets, and the moved check wakes nobody after it', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      const due = await tracked(c, async call => expect((await call(run.tool, { command: 'make check', ...run.args })).error).toBe(false));
      expect(await checkExternalWaits(c.app.ctx, new Date(due.getTime() + MIN))).toBe(0);

      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));

      await until(async () => (await taskRow(c)).externalWait === null);
      await until(async () => (await toldOf(c)).prompts.length > 0);
      await until(async () => (await c.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, c.bruno.id), inArray(pendingWakes.why, ['tests', 'work'])))).length === 0);
      const told = await toldOf(c);
      expect(told.prompts).toHaveLength(1);
      expect(told.prompts[0]).toMatch(new RegExp(`${run.name} 1 (passed|is done)`));
      expect(told.prompts[0]).not.toMatch(/goes on until/);
      expect(told.news).toBe(1);
      expect(await checkExternalWaits(c.app.ctx, new Date(Date.now() + 3 * 3_600_000))).toBe(0);
      expect((await toldOf(c)).prompts).toHaveLength(1);
    });
  });

  it('still wakes its holder at its time when no run of theirs goes on the task', async () => {
    const c = await company();
    const due = await tracked(c, async () => {});

    expect(await checkExternalWaits(c.app.ctx, new Date(due.getTime() + MIN))).toBe(1);

    expect((await taskRow(c)).externalWait).toBeNull();
    await until(async () => (await toldOf(c)).prompts.length > 0);
    const [prompt] = (await toldOf(c)).prompts;
    expect(prompt).toMatch(new RegExp(`Check the progress of #${c.task.number}\\b`));
    expect(prompt).toContain('The run on the checkout');
  });
});
