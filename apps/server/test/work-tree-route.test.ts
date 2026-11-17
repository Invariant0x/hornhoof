import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { createTask, loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import type { DepartmentTree } from '../src/modules/tasks/tree.js';
import { treeFacts } from '../src/modules/tasks/tree-facts.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { verified } from './development-echelons-verification.js';
import { as, invitePerson, listen, mcp, setUpCompany, statements, testApp } from './helpers.js';

async function company({ openTurn = true, openedMinutesAgo = 120 } = {}) {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db
    .insert(subscriptions)
    .values({ companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceo!.id, status: 'ready' })
    .returning();
  const [dev] = await db
    .insert(departments)
    .values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' })
    .returning();
  const [sales] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', repoUrl: null }).returning();

  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, sub: string | null = claude!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: sub === codex!.id ? 'gpt-6.1-sol' : 'claude-opus-5-5', subscriptionId: sub, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;

  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const kai = await hire('Kai', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const rex = await hire('Rex', 'worker', 'DEV-REV', codex!.id);
  const sid = await hire('Sid', 'worker', 'DEV-SEC', codex!.id);
  const tester = await hire('Tess', 'worker', 'DEV-TEST');

  const turnOpenedAt = new Date(Date.now() - openedMinutesAgo * 60_000);
  const [turn] = openTurn
    ? await db
        .insert(turns)
        .values({ companyId, departmentId: dev!.id, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', createdAt: turnOpenedAt, openedAt: turnOpenedAt })
        .returning()
    : [];

  const ctx = app.ctx;
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const parent = openTurn
    ? (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task
    : null;

  const member = async (executor: string, title: string, { productId = null as string | null, body = '', riskClass = 'none' as 'none' | 'security', reviewerAgentId = rita.id } = {}) =>
    (
      await createTask(
        ctx,
        { agentId: head.id },
        { title, brief: '', body, departmentId: dev!.id, productId, parentId: parent?.id ?? null, assigneeAgentId: executor, executor: true, small: true, paths: ['logic/totals.ts'], riskClass, reviewerAgentId, securityAgentId: sid.id, testsAgentId: tester.id },
      )
    ).task;

  const code = { summary: 'Candidate', evidence: 'Changed total tests.', review: { baseCommit: BASE } };
  const snapshot = async (id: string) => {
    const task = await loadTask(db, id);
    return routeSnapshot(await routeOf(db, task), task.assigneeAgentId);
  };
  const accepted = async (executor: string, taskId: string) => {
    await submit(ctx, executor, taskId, code);
    await verdict(ctx, rita.id, taskId, { pass: true, reviewedCommit: HEAD, comment: 'Checked the candidate.' });
    if ((await snapshot(taskId)).stage === 'security') await verdict(ctx, sid.id, taskId, { pass: true, reviewedCommit: HEAD, comment: 'Checked the declared risk.' });
    await report(ctx, tester.id, taskId, verified(await snapshot(taskId)));
    const ready = await snapshot(taskId);
    return report(ctx, head.id, taskId, { done: true, summary: 'Observed the checked candidate in turn-4.', acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: HEAD } });
  };

  let n = 0;
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db
      .insert(jobs)
      .values({ companyId, subscriptionId: claude!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };

  return { app, ctx, db, companyId, ceoToken, claude: claude!, dev: dev!, sales: sales!, turn: turn ?? null, head, bruno, kai, rita, rex, sid, tester, parent, member, code, snapshot, accepted, tools };
}

describe('GET /api/departments/:id/tree', () => {
  it('shows a holder external wait in task details, tree facts and the calm tree state, then removes it after a comment', async () => {
    const c = await company();
    const task = await c.member(c.bruno.id, 'Publish images');
    const client = await c.tools(c.bruno);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const result = await client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Images on the registry', until } });
    expect(result.isError).toBeFalsy();
    const [row] = await c.db.select().from(tasks).where(eq(tasks.id, task.id));
    const facts = await treeFacts(c.db, c.companyId, c.dev.id, () => true);
    expect(facts.tasks.find(t => t.id === task.id)?.externalWait).toEqual(row!.externalWait);
    const detail = await c.app.inject({ url: `/api/tasks/${task.id}`, ...as(c.ceoToken) });
    expect(detail.json().task.externalWait).toEqual(row!.externalWait);
    const readTree = async () => (await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) })).json<{ tree: DepartmentTree }>().tree;
    const line = (await readTree()).lines.find(l => l.taskId === task.id)!;
    expect(line.externalWait).toEqual(row!.externalWait);
    expect(line.segments.at(-1)).toMatchObject({ kind: 'after', externalWait: row!.externalWait });
    const comment = await c.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/comments`, payload: { text: 'Images are ready.' }, ...as(c.ceoToken) });
    expect(comment.statusCode).toBe(201);
    expect((await treeFacts(c.db, c.companyId, c.dev.id, () => true)).tasks.find(t => t.id === task.id)?.externalWait).toBeNull();
    expect((await readTree()).lines.find(l => l.taskId === task.id)?.externalWait).toBeNull();
  });

  it('reads the same reported program history for the tree and Speed', async () => {
    const c = await company();
    const task = await c.member(c.bruno.id, 'Checkout API');
    const start = new Date(Date.now() - 40 * 60_000);
    await c.db.update(tasks).set({ createdAt: start }).where(eq(tasks.id, task.id));
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.claude.id, agentId: c.bruno.id, taskId: task.id,
      kind: 'conversation', prompt: 'Checkout API', timeoutMs: 3_600_000, status: 'running', createdAt: start, startedAt: start }).returning();
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, jobId: job!.id, kind: 'program', createdAt: start,
      data: { program: { state: 'thinking', since: start.getTime(), tool: null }, alarm: null } });
    const res = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) });
    const tree = res.json<{ tree: DepartmentTree }>().tree;
    expect(tree.lines.find(l => l.taskId === task.id)?.segments[0]).toMatchObject({ kind: 'work', program: { state: 'thinking' } });
    expect(tree.time.find(t => t.agent.id === c.bruno.id)?.work).toBeGreaterThanOrEqual(2400);
    expect(tree.time.find(t => t.agent.id === c.bruno.id)?.stall).toBe(0);
  });

  it('shows independent current checkers, candidates and their attributed findings on each task line', async () => {
    const c = await company();
    const api = await c.member(c.bruno.id, 'Checkout API', { riskClass: 'security' });
    const page = await c.member(c.kai.id, 'Checkout page', { reviewerAgentId: c.rex.id });
    await submit(c.ctx, c.bruno.id, api.id, c.code);
    await submit(c.ctx, c.kai.id, page.id, c.code);
    const issues = [1, 2].map(line => ({ category: 'data', blocking: false, path: 'logic/totals.ts', line, harm: `Clarify boundary ${line}.` }));
    const said = await (await c.tools(c.rita)).callTool({ name: 'verdict', arguments: { task: api.number, pass: false, reviewedCommit: HEAD, comment: 'I will repair these boundaries.', issues } });
    expect(said.isError).toBeFalsy();
    const res = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) });
    expect(res.statusCode).toBe(200);
    const { tree } = res.json<{ tree: DepartmentTree }>();
    expect(tree.repository).toBe(true);
    expect(tree.turn).toEqual({ id: c.turn!.id, number: 4, branch: 'turn-4', startedAt: c.turn!.openedAt!.toISOString() });
    expect(tree.lines.map(line => [line.title, line.agent.name, line.part?.id, line.branch])).toEqual([
      ['Payments', 'Hana', undefined, `task-${c.parent!.number}`],
      ['Checkout API', 'Rita', c.parent!.id, `task-${api.number}`],
      ['Checkout page', 'Rex', c.parent!.id, `task-${page.number}`],
    ]);
    expect(tree.lines.find(line => line.taskId === api.id)).toMatchObject({ mergedAt: null, doneAt: null,
      echelons: { stage: 'review', ownerAgentId: c.rita.id, candidateId: (await c.snapshot(api.id)).candidateId },
      echelonFindings: { uniqueReported: 2, review: { reported: 2, confirmed: 0 }, security: { reported: 0, confirmed: 0 } },
    });
    expect(tree.lines.find(line => line.taskId === page.id)).toMatchObject({ mergedAt: null, doneAt: null,
      echelons: { stage: 'review', ownerAgentId: c.rex.id, candidateId: (await c.snapshot(page.id)).candidateId },
    });
    expect(tree).not.toHaveProperty('review');
    expect(tree).not.toHaveProperty('reviews');
  });

  it('shows integration only after the authenticated Tests report and head acceptance', async () => {
    const c = await company();
    const task = await c.member(c.bruno.id, 'Checkout API', { riskClass: 'security' });
    await c.accepted(c.bruno.id, task.id);
    const res = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) });
    expect(res.statusCode).toBe(200);
    const { tree } = res.json<{ tree: DepartmentTree }>();
    const line = tree.lines.find(line => line.taskId === task.id)!;
    expect(line).toMatchObject({ mergedAt: expect.any(String), echelons: { phase: 'done', candidateId: (await c.snapshot(task.id)).candidateId } });
    const reports = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report')));
    const acceptance = reports.find(event => event.data.acceptedCandidate);
    expect(line.mergedAt).toBe(acceptance!.createdAt.toISOString());
    expect(await c.db.select().from(tasks).where(eq(tasks.title, 'Review of turn 4'))).toEqual([]);
  });

  it('preserves observed time across current ownership without counting the author period for the checker', async () => {
    const c = await company();
    const task = await c.member(c.bruno.id, 'Checkout API');
    const start = new Date(Date.now() - 40 * 60_000), finished = new Date(Date.now() - 60_000);
    await c.db.update(tasks).set({ createdAt: start }).where(eq(tasks.id, task.id));
    await c.db.update(taskEvents).set({ createdAt: start }).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'created')));
    const [author] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.claude.id, agentId: c.bruno.id, taskId: task.id,
      kind: 'conversation', prompt: 'Build the API', timeoutMs: 3_600_000, status: 'done', createdAt: start, startedAt: start, finishedAt: finished }).returning();
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, jobId: author!.id, kind: 'program', createdAt: start,
      data: { program: { state: 'thinking', since: start.getTime(), tool: null }, alarm: null } });
    await submit(c.ctx, c.bruno.id, task.id, c.code);
    /* The tree counts up to its own now: on a clock that stands still from here, the checker's turn has taken no time. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const checking = new Date();
    const [reviewer] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.claude.id, agentId: c.rita.id, taskId: task.id,
      kind: 'conversation', prompt: 'Check the candidate', timeoutMs: 3_600_000, status: 'running', createdAt: checking, startedAt: checking }).returning();
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.rita.id, jobId: reviewer!.id, kind: 'program', createdAt: checking,
      data: { program: { state: 'thinking', since: checking.getTime(), tool: null }, alarm: null } });
    const response = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) });
    expect(response.statusCode).toBe(200);
    const { tree } = response.json<{ tree: DepartmentTree }>();
    expect(tree.time.find(time => time.agent.id === c.bruno.id)?.work).toBeGreaterThanOrEqual(2300);
    expect(tree.time.find(time => time.agent.id === c.rita.id)).toMatchObject({ work: 0, unknown: 0 });
  });

  it('keeps completed author time separate from later checking time after acceptance', async () => {
    const c = await company();
    const task = await c.member(c.bruno.id, 'Checkout API');
    const start = new Date(Date.now() - 60 * 60_000);
    const handedOver = new Date(start.getTime() + 20 * 60_000);
    const checked = new Date(start.getTime() + 40 * 60_000);
    await c.db.update(tasks).set({ createdAt: start }).where(eq(tasks.id, task.id));
    await c.db.update(taskEvents).set({ createdAt: start }).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'created')));
    const observed = async (agentId: string, from: Date, to: Date) => {
      const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.claude.id, agentId, taskId: task.id,
        kind: 'conversation', prompt: 'Work on the current stage', timeoutMs: 3_600_000, status: 'done', createdAt: from, startedAt: from, finishedAt: to }).returning();
      await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId, jobId: job!.id, kind: 'program', createdAt: from,
        data: { program: { state: 'thinking', since: from.getTime(), tool: null }, alarm: null } });
    };
    await observed(c.bruno.id, start, handedOver);
    await observed(c.rita.id, handedOver, checked);
    await c.accepted(c.bruno.id, task.id);
    await c.db.update(taskEvents).set({ createdAt: handedOver }).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted')));
    const response = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(c.ceoToken) });
    expect(response.statusCode).toBe(200);
    const { tree } = response.json<{ tree: DepartmentTree }>();
    const author = tree.time.find(time => time.agent.id === c.bruno.id)!;
    expect(author.work).toBeCloseTo(1200, 0);
    expect(author.unknown ?? 0).toBeLessThan(60);
    expect(tree.time.find(time => time.agent.id === c.rita.id)?.work).toBeCloseTo(1200, 0);
    expect(tree.lines.find(line => line.taskId === task.id)?.mergedAt).toEqual(expect.any(String));
  });

  it("keeps candidate and finding details private for a scoped tree reader, who reads every stage's owner", async () => {
    const c = await company();
    /* A person of a product alone runs nothing of the department: the repository's details stay with its people. */
    const [shop] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.dev.id, name: 'Shop', roleCode: 'DEV' }).returning();
    await c.db.update(agents).set({ productId: shop!.id }).where(inArray(agents.id, [c.bruno.id, c.rita.id]));
    const task = await c.member(c.bruno.id, 'Checkout API', { riskClass: 'security', productId: shop!.id });
    await submit(c.ctx, c.bruno.id, task.id, c.code);
    await verdict(c.ctx, c.rita.id, task.id, { pass: false, reviewedCommit: HEAD, comment: 'Checking the boundary.', issues: [{ category: 'data', blocking: false, path: 'logic/totals.ts', line: 1, harm: 'The boundary needs a contract.' }] });
    const token = await invitePerson(c.app, c.ceoToken, { name: 'Dev', email: 'dev@acme.com', access: { departments: [shop!.id] } });
    const listed = await invitePerson(c.app, c.ceoToken, { name: 'Lee', email: 'lee@acme.com', access: { departments: [c.dev.id] } });
    expect((await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(listed) })).body).toContain('The boundary needs a contract.');
    const response = await c.app.inject({ url: `/api/departments/${c.dev.id}/tree`, ...as(token) });
    expect(response.statusCode).toBe(200);
    const { tree } = response.json<{ tree: DepartmentTree }>();
    expect(tree.lines.find(line => line.taskId === task.id)).toMatchObject({
      echelons: { stage: 'review', ownerAgentId: c.rita.id, candidateId: null, assignment: null,
        stages: expect.arrayContaining([expect.objectContaining({ stage: 'security', ownerAgentId: expect.any(String), inputCandidateId: null, candidateId: null })]) },
      echelonFindings: { uniqueReported: 1, uniqueConfirmed: 0, review: { reported: 1, confirmed: 0 }, issues: [] },
    });
    expect(response.body).not.toContain('logic/totals.ts');
    expect(response.body).not.toContain('The boundary needs a contract.');
    expect(response.body).not.toContain(HEAD);
  });

  it('keeps an old action timestamp without guessing the program state during forty quiet minutes', async () => {
    const { app, db, companyId, ceoToken, claude, dev, bruno, member } = await company();
    const api = await member(bruno.id, 'Checkout API');
    const sixtyAgo = new Date(Date.now() - 60 * 60_000);
    const fortyAgo = new Date(Date.now() - 40 * 60_000);

    await db.update(tasks).set({ createdAt: sixtyAgo, updatedAt: sixtyAgo }).where(eq(tasks.id, api.id));
    await db.update(taskEvents).set({ createdAt: sixtyAgo }).where(eq(taskEvents.taskId, api.id));

    const [job] = await db
      .insert(jobs)
      .values({
        companyId,
        subscriptionId: claude.id,
        agentId: bruno.id,
        taskId: api.id,
        kind: 'conversation',
        prompt: 'Work on Checkout API.',
        timeoutMs: 900_000,
        status: 'running',
        createdAt: sixtyAgo,
        startedAt: sixtyAgo,
      })
      .returning();
    await db.insert(agentEvents).values({
      companyId,
      agentId: bruno.id,
      jobId: job!.id,
      kind: 'tool',
      data: { name: 'bash' },
      createdAt: fortyAgo,
    });

    const res = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(ceoToken) });
    expect(res.statusCode).toBe(200);
    const { tree } = res.json<{ tree: DepartmentTree }>();
    expect(tree.lines).toHaveLength(2);
    const line = tree.lines.find(l => l.taskId === api.id)!;
    expect(line.live).toBe(true);
    expect(line.lastActionAt).toBe(fortyAgo.toISOString());
    expect(line.segments).toEqual([
      { kind: 'unknown', from: sixtyAgo.toISOString(), to: null },
    ]);
  });

  it('returns the tree of any department to everyone of the company, and 404 for a product or unknown id', async () => {
    const { app, db, companyId, ceoToken, dev, sales, bruno, kai, member } = await company();
    const [shop] = await db.insert(departments).values({ companyId, parentId: dev.id, name: 'Shop', roleCode: 'DEV' }).returning();
    const [other] = await db.insert(departments).values({ companyId, parentId: dev.id, name: 'Backoffice', roleCode: 'DEV' }).returning();

    await member(bruno.id, 'Shop checkout', { productId: shop!.id });
    await member(kai.id, 'Backoffice export', { productId: other!.id });

    const expected404 = { error: { code: 'not_found', message: 'This department does not exist.', reason: 'department_unknown' } };
    const salesPerson = await invitePerson(app, ceoToken, { name: 'Sasha', email: 'sasha@acme.com', access: { departments: [sales.id] } });
    const another = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(salesPerson) });
    expect(another.statusCode).toBe(200);
    const all = (await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(ceoToken) })).json<{ tree: DepartmentTree }>().tree.lines.map(l => l.title);
    expect(all).toEqual(expect.arrayContaining(['Backoffice export', 'Shop checkout']));
    expect(another.json<{ tree: DepartmentTree }>().tree.lines.map(l => l.title)).toEqual(all);

    const onProduct = await app.inject({ method: 'GET', url: `/api/departments/${shop!.id}/tree`, ...as(ceoToken) });
    expect(onProduct.statusCode).toBe(404);
    expect(onProduct.json()).toEqual(expected404);

    const onUnknown = await app.inject({ method: 'GET', url: `/api/departments/${randomUUID()}/tree`, ...as(ceoToken) });
    expect(onUnknown.statusCode).toBe(404);
    expect(onUnknown.json()).toEqual(expected404);

    const shopPerson = await invitePerson(app, ceoToken, { name: 'Polina', email: 'polina@acme.com', access: { departments: [shop!.id] } });
    const scoped = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(shopPerson) });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json<{ tree: DepartmentTree }>().tree.lines.map(l => l.title)).toEqual(all);
  });

  it('returns turn null and empty lists when there is no open turn, and runs a fixed number of queries across line counts', async () => {
    const none = await company({ openTurn: false });
    const emptyRes = await none.app.inject({ method: 'GET', url: `/api/departments/${none.dev.id}/tree`, ...as(none.ceoToken) });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json<{ tree: DepartmentTree }>().tree).toMatchObject({
      turn: null,
      repository: true,
      lines: [],
      time: [],
      idle: [],
    });

    const live = await company();
    const seen = statements();
    await live.member(live.bruno.id, 'Task one');
    seen.length = 0;
    const oneRes = await live.app.inject({ method: 'GET', url: `/api/departments/${live.dev.id}/tree`, ...as(live.ceoToken) });
    expect(oneRes.statusCode).toBe(200);
    const countWithOneLine = seen.length;

    await live.member(live.kai.id, 'Task two');
    await live.member(live.bruno.id, 'Task three');
    await live.member(live.kai.id, 'Task four');
    seen.length = 0;
    const fourRes = await live.app.inject({ method: 'GET', url: `/api/departments/${live.dev.id}/tree`, ...as(live.ceoToken) });
    expect(fourRes.statusCode).toBe(200);
    expect(fourRes.json<{ tree: DepartmentTree }>().tree.lines).toHaveLength(5);
    expect(seen.length).toBe(countWithOneLine);
  });
});
