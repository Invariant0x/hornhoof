import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, departments, turnSnapshots } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { departmentPipeline, pipelineReport, turnFacts } from '../src/modules/tasks/pipeline-report.js';
import { as, invitePerson } from './helpers.js';
import { at, min, company, type Company, closedTurn } from './pipeline-report-fixture.js';

describe('the facts of any turn', () => {
  it('match the events of a closed turn, by department and for the whole of it', async () => {
    const c = await company();
    const { seven } = await closedTurn(c);
    const facts = await turnFacts(c.db, seven, seven.closedAt!);

    const dev = facts.departments.find(d => d.department.id === c.dev.id)!;
    expect(dev.department.name).toBe('Development');
    expect(dev.tasks).toEqual({ total: 2, done: 2, cancelled: 0, open: 0 });
    expect(dev.toFirstSubmit).toEqual({ count: 2, median: min(10), worst: min(10) });
    expect(dev.toAcceptance).toEqual({ count: 2, median: min(30), worst: min(30) });
    expect(dev.criticalPath).toEqual({ seconds: min(60), tasks: [1, 2] });
    expect(dev.wholeTurn).toBe(min(120));
    expect(dev.stages).toEqual({ work: min(20), review: min(15), fixes: min(5), merge: min(20), turnReview: 0 });
    expect(dev.returns).toBe(1);
    expect(dev.fixRounds).toBe(1);
    expect(dev.interrupted).toBe(1);
    expect(dev.failures).toBe(0);
    expect(dev.kinds.bug?.tasks).toBe(1);

    const sales = facts.departments.find(d => d.department.id === c.sales.id)!;
    expect(sales.tasks.total).toBe(1);
    expect(sales.failures).toBe(1);
    expect(sales.waits.person).toEqual({ count: 1, seconds: min(60) });
    expect(sales.waits.testRuns.count).toBe(0);

    expect(facts.whole.tasks.total).toBe(3);
    expect(facts.whole.criticalPath.seconds).toBe(min(100));
  });

  it('count the agent turns of a turn, on its tasks and outside them, and how many went to the orchestrator, heads and Operations', async () => {
    const c = await company();
    const { seven, one } = await closedTurn(c);
    const [ops] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'operations', roleCode: 'OPS', position: 3 }).returning();
    const [walt] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Walt', roleKey: 'OPS-WATCH', departmentId: ops!.id, model: '', subscriptionId: c.hana.subscriptionId }).returning();
    await c.job(c.hana.id, one.id, { createdAt: at(12) });
    await c.job(c.orchestrator.id, null, { createdAt: at(50) });
    await c.job(walt!.id, null, { createdAt: at(60) });
    /* After the turn closed: not its turn. */
    await c.job(c.orchestrator.id, null, { createdAt: at(130) });
    const facts = await turnFacts(c.db, seven, seven.closedAt!);
    /* The closed turn had four turns of its employees on its three tasks. */
    expect(facts.whole.turns).toEqual({ total: 7, coordination: 3, perTask: 2.33, coordinationShare: 0.43 });
    expect(facts.departments.find(d => d.department.id === c.dev.id)!.turns).toEqual({ total: 4, coordination: 1, perTask: 2, coordinationShare: 0.25 });
  });

  it('keep waits for runs apart from external waits', async () => {
    const c = await company();
    const { seven } = await closedTurn(c);
    const dev = (await turnFacts(c.db, seven, seven.closedAt!)).departments.find(d => d.department.id === c.dev.id)!;
    expect(dev.waits.testRuns).toMatchObject({ count: 1, seconds: min(4), parts: 1, partQueueSeconds: min(1), partRunSeconds: min(3) });
    expect(dev.waits.external.other).toEqual({ count: 1, seconds: min(4) });
    expect(dev.waits.queue.count).toBeGreaterThan(0);
  });

  it('count agent time inside the turn only, also when the agent went on working after it', async () => {
    const c = await company();
    const seven = await c.turn(7, 'closed', 0, 60);
    const one = await c.task(seven.id, 1, { closedAt: at(60) });
    const program = (minutes: number, state: 'thinking') => ({ program: { state, since: at(minutes).getTime(), tool: null }, alarm: null });
    const inTurn = await c.job(c.bruno.id, one.id, { createdAt: at(0), startedAt: at(0), finishedAt: at(60) });
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, jobId: inTurn.id, kind: 'program', data: program(0, 'thinking'), createdAt: at(0) });
    const later = await c.turn(8, 'open', 60, null);
    const next = await c.task(later.id, 2, { status: 'working', closedAt: null, createdAt: at(61) });
    await c.job(c.bruno.id, next.id, { createdAt: at(61), startedAt: at(61), finishedAt: at(400) });

    const dev = (await turnFacts(c.db, seven, seven.closedAt!)).departments[0]!;
    expect(dev.agents.work).toBe(min(60));
    expect(dev.agents.queued).toBe(0);
  });

  it('work for a turn still open, up to now', async () => {
    const c = await company();
    const eight = await c.turn(8, 'open', 0, null);
    await c.task(eight.id, 1, { status: 'working', closedAt: null });
    const facts = await turnFacts(c.db, eight, at(45));
    expect(facts.departments[0]!.tasks).toEqual({ total: 1, done: 0, cancelled: 0, open: 1 });
    expect(facts.departments[0]!.stages.work).toBe(min(45));
  });

  it('have no departments in a turn without tasks', async () => {
    const c = await company();
    const empty = await c.turn(7, 'closed', 0, 10);
    expect((await turnFacts(c.db, empty, empty.closedAt!)).departments).toEqual([]);
  });

  it('measure only closed small tasks from creation to closing, with no data without them', async () => {
    const c = await company();
    const seven = await c.turn(7, 'closed', 0, 120);
    await c.task(seven.id, 1, { small: true, closedAt: at(10) });
    await c.task(seven.id, 2, { small: true, closedAt: at(20) });
    await c.task(seven.id, 3, { small: true, closedAt: at(40) });
    await c.task(seven.id, 4, { small: false, closedAt: at(100) });
    await c.task(seven.id, 5, { small: true, status: 'working', closedAt: null });
    const facts = await turnFacts(c.db, seven, seven.closedAt!);
    expect(facts.whole.small).toEqual({ count: 3, median: min(20), worst: min(40) });
    expect(facts.departments[0]!.small).toEqual({ count: 3, median: min(20), worst: min(40) });

    const eight = await c.turn(8, 'closed', 120, 240);
    await c.task(eight.id, 6, { small: false, closedAt: at(180) });
    expect((await turnFacts(c.db, eight, eight.closedAt!)).whole.small).toEqual({ count: 0, median: null, worst: null });
  });
});

describe('the snapshot of a turn', () => {
  /* Keeping it as the tag of its release closes the turn: in turn-tag-close.test.ts. */
  it('is built from the events for a turn that closed before snapshots, once, and stays as it was', async () => {
    const c = await company();
    const { seven, one } = await closedTurn(c);
    expect(await c.db.select().from(turnSnapshots)).toEqual([]);

    const report = await pipelineReport(c.db, c.companyId, 7);
    expect(report.turn).toMatchObject({ number: 7, status: 'closed', source: 'rebuilt' });
    const [kept] = await c.db.select().from(turnSnapshots).where(eq(turnSnapshots.turnId, seven.id));
    expect(kept!.source).toBe('rebuilt');
    expect(kept!.facts.whole.tasks.total).toBe(3);

    await c.event(one.id, 'verdict', 31, { pass: false, rework: true });
    const again = await pipelineReport(c.db, c.companyId, 7);
    expect(again.whole.find(r => r.key === 'returns')!.value).toBe(1);
    expect(await c.db.select({ n: sql<number>`count(*)::int` }).from(turnSnapshots)).toEqual([{ n: 1 }]);
  });

});

describe('the report', () => {
  const row = (rows: { key: string }[], key: string) => rows.find(r => r.key === key);

  /* Closed turns with one done task each, of these minutes from giving out to accepting. */
  async function turnsOf(c: Company, lengths: Record<number, number>) {
    for (const [turn, minutes] of Object.entries(lengths)) {
      const closed = await c.turn(Number(turn), 'closed', 0, minutes);
      await c.task(closed.id, 100 + Number(turn), { closedAt: at(minutes) });
    }
  }

  it('compares every number with the previous turn and the baseline in percent', async () => {
    const c = await company();
    await turnsOf(c, { 7: 100, 8: 50, 9: 40 });
    const report = await pipelineReport(c.db, c.companyId, 9);
    expect(report.turn.number).toBe(9);
    expect(report.previous?.number).toBe(8);
    expect(report.baseline?.number).toBe(7);
    const dev = report.departments.find(d => d.department.id === c.dev.id)!;
    expect(row(dev.rows, 'toAcceptance.median')).toEqual({ section: 'time', key: 'toAcceptance.median', unit: 'seconds', value: min(40), previous: min(50), baseline: min(100), vsPrevious: -20, vsBaseline: -60 });
    expect(row(report.whole, 'tasks.done')).toMatchObject({ value: 1, previous: 1, baseline: 1, vsPrevious: 0, vsBaseline: 0 });
  });

  it('has nothing to compare with for a first turn, and the baseline is the first that ran', async () => {
    const c = await company();
    await turnsOf(c, { 1: 10, 2: 20 });
    const first = await pipelineReport(c.db, c.companyId, 1);
    expect(first.previous).toBeNull();
    expect(first.baseline).toBeNull();
    expect(row(first.whole, 'toAcceptance.median')).toMatchObject({ value: min(10), previous: null, baseline: null, vsPrevious: null, vsBaseline: null });
    const second = await pipelineReport(c.db, c.companyId, 2);
    expect(second.baseline?.number).toBe(1);
  });

  it('skips turns that never ran when it looks for the previous one', async () => {
    const c = await company();
    await turnsOf(c, { 7: 100 });
    await c.turn(8, 'closed', null, 200);
    await c.turn(9, 'closed', 300, 300);
    await turnsOf(c, { 10: 50 });
    const report = await pipelineReport(c.db, c.companyId, 10);
    expect(report.previous?.number).toBe(7);
    expect(report.turns).toEqual([10, 7]);
  });

  it('reads the open turn by default, live', async () => {
    const c = await company();
    await turnsOf(c, { 7: 100 });
    const open = await c.turn(8, 'open', 0, null);
    await c.task(open.id, 200, { status: 'working', closedAt: null });
    const report = await pipelineReport(c.db, c.companyId);
    expect(report.turn).toMatchObject({ number: 8, status: 'open', source: 'live', closedAt: null });
    expect(report.previous?.number).toBe(7);
    expect(await c.db.select(only(turnSnapshots, 'turnId')).from(turnSnapshots).where(eq(turnSnapshots.turnId, open.id))).toEqual([]);
  });

  it('compares a turn with the turns of its own department only', async () => {
    const c = await company();
    await turnsOf(c, { 7: 100, 8: 50 });
    const launch = await c.turn(9, 'closed', 0, 70, 'Launch', c.sales.id);
    await c.task(launch.id, 109, { departmentId: c.sales.id, executorAgentId: c.sam.id, closedAt: at(70) });
    await turnsOf(c, { 10: 40 });
    const report = await pipelineReport(c.db, c.companyId, 10);
    expect(report.previous?.number).toBe(8);
    expect(report.baseline?.number).toBe(7);
    expect(report.turns).toEqual([10, 8, 7]);
    const sales = await pipelineReport(c.db, c.companyId, 9);
    expect(sales.previous).toBeNull();
    expect(sales.baseline).toBeNull();
    expect(sales.turns).toEqual([9]);
  });

  it("reads a department's own running turn by default", async () => {
    const c = await company();
    const payments = await c.turn(1, 'open', 0, null);
    await c.task(payments.id, 101, { status: 'working', closedAt: null });
    const launch = await c.turn(2, 'open', 0, null, 'Launch', c.sales.id);
    await c.task(launch.id, 102, { departmentId: c.sales.id, executorAgentId: c.sam.id, status: 'working', closedAt: null });
    expect((await departmentPipeline(c.db, c.companyId, c.sales.id)).turn.number).toBe(2);
    expect((await departmentPipeline(c.db, c.companyId, c.dev.id)).turn.number).toBe(1);
    expect((await pipelineReport(c.db, c.companyId, undefined, c.sales.id)).turn.number).toBe(2);
  });

  it('reads the last closed turn by default when none is open, and refuses one there is not', async () => {
    const c = await company();
    await turnsOf(c, { 7: 100 });
    expect((await pipelineReport(c.db, c.companyId)).turn.number).toBe(7);
    await expect(pipelineReport(c.db, c.companyId, 8)).rejects.toMatchObject({ status: 404 });
    await expect(pipelineReport(c.db, c.companyId, 99)).rejects.toMatchObject({ status: 404 });
  });

  it('counts a bug made later that names a task of the turn, also after its snapshot', async () => {
    const c = await company();
    const { seven } = await closedTurn(c);
    await pipelineReport(c.db, c.companyId, 7);
    const eight = await c.turn(8, 'open', 200, null);
    await c.task(eight.id, 50, { workKind: 'bug', status: 'working', closedAt: null, createdAt: at(201), body: 'It broke in #1.' });
    await c.task(eight.id, 51, { status: 'working', closedAt: null, createdAt: at(202), body: 'Вид: ошибка. Класс риска: нет.\nAnd in #2.' });
    await c.task(eight.id, 52, { workKind: 'known_behavior', status: 'working', closedAt: null, createdAt: at(203), body: 'Builds on #1.' });
    expect(seven.number).toBe(7);
    const report = await pipelineReport(c.db, c.companyId, 7);
    const dev = report.departments.find(d => d.department.id === c.dev.id)!;
    expect(row(dev.rows, 'quality.laterBugs')).toMatchObject({ section: 'quality', value: 2 });
    expect(row(dev.rows, 'kinds.bug.laterBugs')).toMatchObject({ section: 'kinds', value: 1 });
    expect(row(dev.rows, 'kinds.unset.laterBugs')).toMatchObject({ value: 1 });
  });

  it('shows no number for test selection misses, and says whether a department has a description', async () => {
    const c = await company();
    await closedTurn(c);
    const report = await pipelineReport(c.db, c.companyId, 7);
    const dev = report.departments.find(d => d.department.id === c.dev.id)!;
    expect(row(dev.rows, 'selectionMisses')).toMatchObject({ value: null, vsPrevious: null });
    expect(dev.described).toBe(false);
    expect(report.departments.find(d => d.department.id === c.sales.id)!.described).toBe(true);
    expect(dev.criticalPath).toEqual([1, 2]);
  });

  it('gives one department its part, and none when it had no tasks in that turn', async () => {
    const c = await company();
    await closedTurn(c);
    const [other] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'design', roleCode: 'DSN', position: 3 }).returning();
    const dev = await departmentPipeline(c.db, c.companyId, c.dev.id, 7);
    expect(dev.department?.department.id).toBe(c.dev.id);
    expect(dev).not.toHaveProperty('whole');
    expect(dev).not.toHaveProperty('departments');
    expect((await departmentPipeline(c.db, c.companyId, other!.id, 7)).department).toBeNull();
  });

  it('leaves another company out', async () => {
    const c = await company();
    await closedTurn(c);
    await expect(pipelineReport(c.db, randomUUID(), 7)).rejects.toMatchObject({ status: 404 });
  });
});

describe('who reads the report', () => {
  const get = (c: Company, token: string, department: string, query = '') => c.app.inject({ method: 'GET', url: `/api/departments/${department}/pipeline${query}`, ...as(token) });

  it('gives the CEO a department of any turn', async () => {
    const c = await company();
    await closedTurn(c);
    const res = await get(c, c.ceoToken, c.dev.id, '?turn=7');
    expect(res.statusCode).toBe(200);
    expect(res.json().report.department.department.id).toBe(c.dev.id);
    expect(res.json().report.turn.number).toBe(7);
  });

  it('gives the numbers of a whole department to everyone of the company, as the CEO reads them, whatever they reach', async () => {
    const c = await company();
    await closedTurn(c);
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Shop', parentId: c.dev.id, roleCode: 'DEV', position: 1 }).returning();
    const people = [
      await invitePerson(c.app, c.ceoToken, { name: 'Lena', email: 'lena@acme.example', access: { departments: [c.sales.id] } }),
      await invitePerson(c.app, c.ceoToken, { name: 'Zed', email: 'zed@acme.example', access: { whole: true } }),
      await invitePerson(c.app, c.ceoToken, { name: 'Pia', email: 'pia@acme.example', access: { departments: [product!.id] } }),
    ];
    for (const id of [c.sales.id, c.dev.id]) {
      const ceo = (await get(c, c.ceoToken, id, '?turn=7')).json();
      for (const token of people) {
        const res = await get(c, token, id, '?turn=7');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(ceo);
      }
    }
  });

  it('refuses an unknown department, a bad turn, and no sign-in', async () => {
    const c = await company();
    await closedTurn(c);
    expect((await get(c, c.ceoToken, '00000000-0000-4000-8000-000000000099')).statusCode).toBe(404);
    expect((await get(c, c.ceoToken, c.dev.id, '?turn=99')).statusCode).toBe(404);
    expect((await get(c, c.ceoToken, c.dev.id, '?turn=abc')).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'GET', url: `/api/departments/${c.dev.id}/pipeline` })).statusCode).toBe(401);
  });

  it('gives the orchestrator a tool for the whole company, and no one else', async () => {
    const c = await company();
    await closedTurn(c);
    const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name);
    const client = await c.tools(c.orchestrator);
    expect(await names(client)).toContain('pipeline_report');
    expect(await names(await c.tools(c.hana))).not.toContain('pipeline_report');
    expect(await names(await c.tools(c.bruno))).not.toContain('pipeline_report');
    const res = (await client.callTool({ name: 'pipeline_report', arguments: { turn: 7 } })) as { content: { text: string }[] };
    const report = JSON.parse(res.content[0]!.text);
    expect(report.turn.number).toBe(7);
    expect(report.departments.map((d: { department: { name: string } }) => d.department.name).sort()).toEqual(['Development', 'Sales']);
    expect(report.whole.length).toBeGreaterThan(10);
    const bad = (await client.callTool({ name: 'pipeline_report', arguments: { turn: 99 } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
  });
});
