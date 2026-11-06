import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { insertTurn, openTypedTurn, pump } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { turnAgain } from '../src/modules/tasks/again.js';
import { blocked, comment, createTask, submit, verdict, type Task, type Wake } from '../src/modules/tasks/engine.js';
import type { NewIssue } from '../src/modules/tasks/review-findings.js';
import { repeatedTurn } from '../src/modules/tasks/wake-state.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import type { CommitWanted } from '../src/modules/testruns/refs.js';
import { failureCompany } from './failure-company.js';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/* What the role templates set; templates.test.ts holds them to it. */
const REVIEWER = 'xhigh';
const HEAD = 'high';

const finding = (category: NewIssue['category'], blocking = true): NewIssue => ({ category, blocking, path: 'src/checkout.ts', line: 1, harm: 'A buyer can be charged twice.' });

/* The commit each task's branch stands at, as the repository would tell. */
const commitOf = (commits: Map<number, string>, want: CommitWanted) =>
  'task' in want ? { branch: `task-${want.task}`, commitSha: commits.get(want.task)! } : { branch: want.branch, commitSha: 'a'.repeat(40) };

type RunFrame = { type: string; jobId: string; effort: string | null };
const startedOneOf = (own: Set<string>) => (frame: RunFrame) => frame.type === 'job.run' && own.has(frame.jobId);

async function gateCompany() {
  const c = await failureCompany();
  const { ctx, db } = c;
  await db.update(subscriptions).set({ models: [{ id: 'm', name: 'M', efforts: LEVELS }] }).where(eq(subscriptions.id, c.sub.id));
  const [person] = await db.select().from(people);
  const [authorPlan] = await db.insert(subscriptions).values({ companyId: c.companyId, provider: 'openai_api', kind: 'api_key', label: 'Author vendor', ownerPersonId: person!.id, secretEnc: c.sub.secretEnc, status: 'ready', models: [{ id: 'm', name: 'M', efforts: LEVELS }] }).returning();
  await db.update(agents).set({ subscriptionId: authorPlan!.id }).where(eq(agents.id, c.agent.id));
  await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.dev.id));
  const commits = new Map<number, string>();
  ctx.readCommit = async (_repo, want) => commitOf(commits, want);
  ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['src/checkout.ts'], diff: '@@ -1 +1 @@\n-old\n+fixed' });
  const [rita] = await db.insert(agents).values({ companyId: c.companyId, name: 'Rita', kind: 'worker', roleKey: 'DEV-REV', departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  const reviewer = rita!;
  const bruno = c.agent;
  const parent = (await createTask(ctx, { personId: person!.id }, { title: 'Payments', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
  const task = async (title: string, gate = reviewer.id): Promise<Task> =>
    (await createTask(ctx, { agentId: c.head.id }, { title, brief: '', body: '', departmentId: c.dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, gates: [gate] })).task;
  /* A turn that brings a report waits a moment for what else comes; here nothing does. */
  const wake = async (wakes: Wake[]) => {
    await wakeAll(ctx, wakes);
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.status, 'queued'));
    for (const w of wakes) await pump(ctx, w.agentId);
  };
  /* Word for word the same hand-in is taken for a repeat of the last. */
  let handedIn = 0;
  const handIn = async (t: Task) => {
    commits.set(t.number, (++handedIn).toString(16).padStart(40, '0'));
    return wake((await submit(ctx, bruno.id, t.id, { summary: `Done, take ${handedIn}.`, evidence: 'Unit checks' })).wakes);
  };
  const sendBack = async (t: Task, by = reviewer.id, issues: NewIssue[] = [finding('spec')]) => wake((await verdict(ctx, by, t.id, { pass: false, comment: 'A test is missing.', reviewedCommit: commits.get(t.number)!, issues })).wakes);
  const running = async (agentId: string) => (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))))[0];
  const endTurn = async (agentId: string) =>
    handleNodeMessage(ctx, BUILTIN, { type: 'job.done', jobId: (await running(agentId))!.id, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
  /* The level of every turn the agent's program was started for, in the order they went out. */
  const levels = async (agentId: string) => {
    const own = new Set((await c.turnsOf(agentId)).map(j => j.id));
    return c.sent.mock.calls.map(([, frame]) => frame as unknown as RunFrame).filter(startedOneOf(own)).map(f => f.effort);
  };
  /* Work sent back once and fixed, so the reviewer's next word on it is a look again. Its turns are over. */
  const sentBackOnce = async (t: Task, by = reviewer.id) => {
    await handIn(t);
    await sendBack(t, by);
    await endTurn(by);
    await endTurn(bruno.id);
  };
  const card = (agentId: string, effort: string | null) => db.update(agents).set({ effort }).where(eq(agents.id, agentId));
  const cardOf = async (agentId: string) => (await db.select({ effort: agents.effort }).from(agents).where(eq(agents.id, agentId)))[0]!.effort;
  const busy = async (agentId: string) => {
    await insertTurn(ctx, { companyId: c.companyId, agentId, prompt: 'Something else.', createdBy: null });
    await pump(ctx, agentId);
  };
  return { ...c, reviewer, bruno, task, wake, handIn, sendBack, running, endTurn, levels, sentBackOnce, card, cardOf, busy };
}

describe('how hard each turn thinks', () => {
  it('starts a first look at the base and the look again at the fixes at medium', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
    await c.sendBack(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium']);
  });

  it('takes medium for merging what passed its gates', async () => {
    const c = await gateCompany();
    await c.card(c.bruno.id, 'high');
    const task = await c.task('Checkout API');
    await c.db.update(tasks).set({ status: 'working', merging: true }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'merge' }]);
    expect(await c.levels(c.bruno.id)).toEqual(['medium']);
  });

  it('holds the level on the card for first looks, lowers the look again and leaves the card as it was', async () => {
    const c = await gateCompany();
    await c.card(c.reviewer.id, 'max');
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(await c.task('Refunds'));
    expect(await c.levels(c.reviewer.id)).toEqual(['max', 'medium', 'max']);
    expect(await c.cardOf(c.reviewer.id)).toBe('max');
  });

  it('claims no level for a model that names none, on a look again either', async () => {
    const c = await gateCompany();
    await c.db.update(subscriptions).set({ models: [{ id: 'm', name: 'M' }] }).where(eq(subscriptions.id, c.sub.id));
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([null, null]);
  });

  it('takes what the running model has: the levels all its models share on the Default, the nearest above medium', async () => {
    const c = await gateCompany();
    await c.db.update(subscriptions).set({ models: [{ id: 'narrow', name: 'Narrow', efforts: ['low', 'high', 'xhigh'] }, { id: 'wide', name: 'Wide', efforts: LEVELS }] }).where(eq(subscriptions.id, c.sub.id));
    const relook = async (model: string, title: string) => {
      await c.db.update(agents).set({ model }).where(eq(agents.id, c.reviewer.id));
      const task = await c.task(title);
      await c.sentBackOnce(task);
      await c.handIn(task);
      await c.wake((await verdict(c.ctx, c.reviewer.id, task.id, { pass: true, comment: 'Fine.' })).wakes);
      await c.endTurn(c.reviewer.id);
    };
    await relook('', 'On the Default');
    await relook('wide', 'On the wide model');
    await relook('gone', 'On a model the plan does not run');
    expect(await c.levels(c.reviewer.id)).toEqual(['xhigh', 'high', 'xhigh', 'medium', 'xhigh', 'high']);
  });

  describe('for fixes that come back from a gate', () => {
    const FULL = 'xhigh';
    const handedIn = async () => {
      const c = await gateCompany();
      await c.card(c.bruno.id, FULL);
      const back = await c.task('Checkout API');
      await c.handIn(back);
      return { ...c, back };
    };
    const backWith = async (...issues: NewIssue[]) => {
      const c = await handedIn();
      await c.sendBack(c.back, c.reviewer.id, issues);
      return c;
    };
    /* A second reviewer of another vendor joins the panel, as a gate takes one reviewer of each. */
    const withSecondReviewer = async () => {
      const c = await gateCompany();
      await c.card(c.bruno.id, FULL);
      const [person] = await c.db.select().from(people);
      const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'kimi', kind: 'personal', label: 'Second reviewer', ownerPersonId: person!.id, status: 'ready', models: [{ id: 'm', name: 'M', efforts: LEVELS }] }).returning();
      const [second] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Sam', kind: 'worker', roleKey: 'DEV-REV', departmentId: c.dev.id, subscriptionId: plan!.id, model: '' }).returning();
      const back = await c.task('Checkout API');
      await c.handIn(back);
      return { ...c, back, second: second! };
    };

    it('takes medium when every finding is marked mechanical, and leaves the card as it was', async () => {
      const c = await backWith(finding('mechanical'), finding('mechanical', false));
      expect(await c.levels(c.bruno.id)).toEqual(['medium']);
      expect(await c.cardOf(c.bruno.id)).toBe(FULL);
    });

    it.each<[string, NewIssue[]]>([
      ['a security finding', [finding('security')]],
      ['a data finding', [finding('data')]],
      ['a finding of the task', [finding('spec')]],
      ['a finding of no category it knows', [finding('other')]],
      ['a mechanical finding beside another', [finding('mechanical'), finding('other')]],
      ['a mechanical remark beside what blocks', [finding('mechanical', false), finding('security')]],
      ['mechanical remarks that block nothing', [finding('mechanical', false)]],
    ])('keeps the level for %s', async (_name, issues) => {
      const c = await backWith(...issues);
      expect(await c.levels(c.bruno.id)).toEqual([FULL]);
    });

    it('keeps the level for a verdict that names no findings, whatever its words say', async () => {
      const c = await handedIn();
      await c.wake((await verdict(c.ctx, c.reviewer.id, c.back.id, { pass: false, comment: 'Only mechanical fixes: category mechanical, formatting.' })).wakes);
      expect(await c.levels(c.bruno.id)).toEqual([FULL]);
    });

    it('keeps the level when one reviewer of a panel marks its findings and the other does not', async () => {
      const c = await withSecondReviewer();
      await c.sendBack(c.back, c.reviewer.id, [finding('mechanical')]);
      await c.sendBack(c.back, c.second.id, [finding('spec')]);
      expect(await c.levels(c.bruno.id)).toEqual([FULL]);
    });

    it('keeps the level when one reviewer of a panel marks its findings and the other names none', async () => {
      const c = await withSecondReviewer();
      await c.sendBack(c.back, c.reviewer.id, [finding('mechanical')]);
      await c.wake((await verdict(c.ctx, c.second.id, c.back.id, { pass: false, comment: 'Look at the totals.' })).wakes);
      expect(await c.levels(c.bruno.id)).toEqual([FULL]);
    });

    it('takes medium when all who sent it back marked their findings, with or without a pass beside them', async () => {
      const both = await withSecondReviewer();
      await both.sendBack(both.back, both.reviewer.id, [finding('mechanical')]);
      await both.sendBack(both.back, both.second.id, [finding('mechanical')]);
      expect(await both.levels(both.bruno.id)).toEqual(['medium']);

      const one = await withSecondReviewer();
      await one.wake((await verdict(one.ctx, one.second.id, one.back.id, { pass: true, comment: 'Fine.' })).wakes);
      await one.sendBack(one.back, one.reviewer.id, [finding('mechanical')]);
      expect(await one.levels(one.bruno.id)).toEqual(['medium']);
    });

    it('keeps the level when a look again finds the fixes still wanting', async () => {
      const c = await gateCompany();
      await c.card(c.bruno.id, FULL);
      const task = await c.task('Checkout API');
      await c.sentBackOnce(task);
      await c.handIn(task);
      await c.wake((await verdict(c.ctx, c.reviewer.id, task.id, { pass: false, comment: 'It can still charge twice.' })).wakes);
      expect(await c.levels(c.bruno.id)).toEqual([FULL, FULL]);
    });

    it('goes back to the level on the next fixes nobody marked', async () => {
      const c = await backWith(finding('mechanical'));
      await c.endTurn(c.bruno.id);
      const next = await c.task('Refunds');
      await c.handIn(next);
      await c.sendBack(next);
      expect(await c.levels(c.bruno.id)).toEqual(['medium', FULL]);
    });

    it('keeps medium when the turn of the fixes is run once more', async () => {
      const c = await backWith(finding('mechanical'));
      const cut = (await c.running(c.bruno.id))!;
      await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted' }).where(eq(jobs.id, cut.id));
      const ended = await repeatedTurn(c.db, cut.id, 'restart');
      await turnAgain(c.ctx, ended!, 'Your last turn was cut.', { retryOf: cut.id });
      await pump(c.ctx, c.bruno.id);
      expect(await c.levels(c.bruno.id)).toEqual(['medium', 'medium']);
    });

    it('keeps the level when new words join the turn of the fixes while it waits', async () => {
      const c = await handedIn();
      await c.busy(c.bruno.id);
      await c.sendBack(c.back, c.reviewer.id, [finding('mechanical')]);
      await c.wake((await comment(c.ctx, { agentId: c.head.id }, c.back.id, 'Rebase on the refunds first.')).wakes);
      await c.endTurn(c.bruno.id);
      expect(await c.turnsOf(c.bruno.id)).toHaveLength(2);
      expect(await c.levels(c.bruno.id)).toEqual([FULL, FULL]);
    });

    it('never changes the turn that runs: the mark starts no program, and the next turn takes medium', async () => {
      const c = await handedIn();
      await c.busy(c.bruno.id);
      const running = await c.running(c.bruno.id);
      const before = c.sent.mock.calls.length;

      await c.sendBack(c.back, c.reviewer.id, [finding('mechanical')]);

      expect((await c.running(c.bruno.id))!.id).toBe(running!.id);
      expect(c.sent.mock.calls.length).toBe(before);
      await c.endTurn(c.bruno.id);
      expect(await c.levels(c.bruno.id)).toEqual([FULL, 'medium']);
    });

    it.each<[string, string[] | undefined, string | null, string | null]>([
      ['the nearest level above medium for a model without it', ['low', 'high', 'xhigh'], FULL, 'high'],
      ['the card when it stands below medium, as a lighter turn never raises it', LEVELS, 'low', 'low'],
      ['the card for a model that names no levels, as nothing says it takes a lighter one', undefined, FULL, FULL],
      ['no level for a model that names none and a card that names none', undefined, null, null],
    ])('takes %s', async (_name, efforts, card, level) => {
      const c = await gateCompany();
      const [own] = await c.db.select({ plan: agents.subscriptionId }).from(agents).where(eq(agents.id, c.bruno.id));
      await c.db.update(subscriptions).set({ models: [{ id: 'm', name: 'M', ...(efforts ? { efforts } : {}) }] }).where(eq(subscriptions.id, own!.plan!));
      await c.card(c.bruno.id, card);
      const task = await c.task('Checkout API');
      await c.handIn(task);
      await c.sendBack(task, c.reviewer.id, [finding('mechanical')]);
      expect(await c.levels(c.bruno.id)).toEqual([level]);
    });
  });

  describe('for a merge', () => {
    const withRepository = async () => {
      const c = await gateCompany();
      await c.db.update(departments).set({ repoUrl: 'https://example.invalid/repo.git' }).where(eq(departments.id, c.dev.id));
      await c.card(c.bruno.id, 'xhigh');
      const task = await c.task('Checkout API');
      await c.handIn(task);
      await c.wake((await verdict(c.ctx, c.reviewer.id, task.id, { pass: true, comment: 'Fine.' })).wakes);
      return { ...c, merging: task };
    };

    it('takes medium from the gate that really passed it', async () => {
      const c = await withRepository();
      expect((await c.db.select({ merging: tasks.merging }).from(tasks).where(eq(tasks.id, c.merging.id)))[0]!.merging).toBe(true);
      expect(await c.levels(c.bruno.id)).toEqual(['medium']);
    });

    it('goes back to the full level once a merge that failed was reported: mending it is no mechanical work', async () => {
      const c = await withRepository();
      await c.wake((await blocked(c.ctx, c.bruno.id, c.merging.id, 'A conflict in the routes.')).wakes);
      await c.endTurn(c.bruno.id);
      expect(await c.levels(c.head.id)).toEqual([HEAD]);
      await c.endTurn(c.head.id);
      await c.wake((await comment(c.ctx, { agentId: c.head.id }, c.merging.id, 'Mend it and hand it in.')).wakes);
      expect(await c.levels(c.bruno.id)).toEqual(['medium', 'xhigh']);
    });
  });

  describe('for words typed into the terminal', () => {
    const typed = async (c: Awaited<ReturnType<typeof gateCompany>>, agentId: string) => {
      const [person] = await c.db.select().from(people);
      return (await openTypedTurn(c.ctx, BUILTIN, agentId, 'Typed words.', person!.id))!;
    };

    it('starts no program and picks no level: the turn runs on what the program has, and the next wake takes its own', async () => {
      const c = await gateCompany();
      const lookedAt = await c.task('Checkout API');
      await c.sentBackOnce(lookedAt);
      expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
      const before = c.sent.mock.calls.length;

      const opened = await typed(c, c.reviewer.id);

      expect(c.sent.mock.calls.length).toBe(before);
      expect((await c.running(c.reviewer.id))!.id).toBe(opened.jobId);
      await c.handIn(lookedAt);
      expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
      expect((await c.running(c.reviewer.id))!.id).toBe(opened.jobId);

      await c.endTurn(c.reviewer.id);
      expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium']);
    });

    it('keeps a mark that comes during a typed turn for the next turn: it starts no program and changes no level', async () => {
      const c = await gateCompany();
      await c.card(c.bruno.id, 'xhigh');
      await c.busy(c.bruno.id);
      await c.endTurn(c.bruno.id);
      const task = await c.task('Checkout API');
      await c.handIn(task);
      const opened = await typed(c, c.bruno.id);
      const before = c.sent.mock.calls.length;

      await c.sendBack(task, c.reviewer.id, [finding('mechanical')]);

      expect(c.sent.mock.calls.length).toBe(before);
      expect((await c.running(c.bruno.id))!.id).toBe(opened.jobId);
      expect(await c.cardOf(c.bruno.id)).toBe('xhigh');
      await c.endTurn(c.bruno.id);
      expect(await c.levels(c.bruno.id)).toEqual(['xhigh', 'medium']);
    });

    it('takes the level of the next wake, not of the turn typed before it', async () => {
      const c = await gateCompany();
      const lookedAt = await c.task('Checkout API');
      await c.sentBackOnce(lookedAt);
      await c.handIn(lookedAt);
      await c.wake((await verdict(c.ctx, c.reviewer.id, lookedAt.id, { pass: true, comment: 'Fine.' })).wakes);
      await c.endTurn(c.reviewer.id);
      expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium']);

      await typed(c, c.reviewer.id);
      await c.endTurn(c.reviewer.id);
      await c.handIn(await c.task('Refunds'));

      expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium', REVIEWER]);
    });
  });

  it('never changes a running turn: what comes while it runs starts no program, and the next turn takes its own level', async () => {
    const c = await gateCompany();
    const lookedAt = await c.task('Checkout API');
    await c.sentBackOnce(lookedAt);
    await c.handIn(await c.task('Refunds'));
    const firstLook = await c.running(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, REVIEWER]);
    const before = c.sent.mock.calls.length;

    await c.handIn(lookedAt);
    await c.card(c.reviewer.id, 'low');
    await pump(c.ctx, c.reviewer.id);

    expect(c.sent.mock.calls.length).toBe(before);
    expect((await c.running(c.reviewer.id))!.id).toBe(firstLook!.id);
    await c.card(c.reviewer.id, null);
    await c.endTurn(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, REVIEWER, 'medium']);
  });

  it('goes back to the base on the turn after a look again', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(await c.task('Refunds'));
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium', REVIEWER]);
  });

  it('keeps medium when a look again is run once more', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    const look = (await c.running(c.reviewer.id))!;
    await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted' }).where(eq(jobs.id, look.id));
    const ended = await repeatedTurn(c.db, look.id, 'restart');
    await turnAgain(c.ctx, ended!, 'Your last turn was cut.', { retryOf: look.id });
    await pump(c.ctx, c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium', 'medium']);
  });

  it('gives a comment its own turn at the base when a look again waits with its report', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.busy(c.reviewer.id);
    await c.handIn(task);
    await c.wake((await comment(c.ctx, { agentId: c.head.id }, task.id, 'Look at the refunds as well.')).wakes);
    await c.endTurn(c.reviewer.id);
    await c.endTurn(c.reviewer.id);
    expect((await c.levels(c.reviewer.id)).slice(-2)).toEqual(['medium', REVIEWER]);
  });

  it('keeps the base when new words join a waiting turn that needed less', async () => {
    const c = await gateCompany();
    await c.card(c.bruno.id, 'high');
    const task = await c.task('Checkout API');
    await c.db.update(tasks).set({ status: 'working', merging: true }).where(eq(tasks.id, task.id));
    await c.busy(c.bruno.id);
    await c.wake([{ agentId: c.bruno.id, taskId: task.id, why: 'merge' }]);
    await c.wake((await comment(c.ctx, { agentId: c.head.id }, task.id, 'Rebase on the refunds first.')).wakes);
    await c.endTurn(c.bruno.id);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(2);
    expect(await c.levels(c.bruno.id)).toEqual(['high', 'high']);
  });

  describe('for a head who reads several tasks in one turn', () => {
    async function headAtTwoGates() {
      const c = await gateCompany();
      const [one, two] = [await c.task('Checkout API', c.head.id), await c.task('Refunds', c.head.id)];
      await c.sentBackOnce(one!, c.head.id);
      await c.sentBackOnce(two!, c.head.id);
      await c.busy(c.head.id);
      return { ...c, one: one!, two: two! };
    }

    it('takes medium only when every one of them is a look again', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(c.two);
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe('medium');
    });

    it('keeps the base when one of them has no words to say why', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(c.two);
      const [waiting] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.taskId, c.two.id), eq(jobs.status, 'queued')));
      await c.db.delete(agentEvents).where(eq(agentEvents.jobId, waiting!.id));
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe(HEAD);
    });

    it('keeps the base when one of them is a first look', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(await c.task('Invoices', c.head.id));
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe(HEAD);
    });
  });
});
