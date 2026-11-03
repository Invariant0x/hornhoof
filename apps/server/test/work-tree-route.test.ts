import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import type { DepartmentTree } from '../src/modules/tasks/tree.js';
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
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub }).returning())[0]!;

  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const kai = await hire('Kai', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const rex = await hire('Rex', 'worker', 'DEV-REV', codex!.id);
  const sid = await hire('Sid', 'worker', 'DEV-SEC');

  const turnOpenedAt = new Date(Date.now() - openedMinutesAgo * 60_000);
  const [turn] = openTurn
    ? await db
        .insert(turns)
        .values({ companyId, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', createdAt: turnOpenedAt, openedAt: turnOpenedAt })
        .returning()
    : [];

  const ctx = app.ctx;
  const parent = openTurn
    ? (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task
    : null;

  const member = async (executor: string, title: string, { productId = null as string | null } = {}) =>
    (
      await createTask(
        ctx,
        { agentId: head.id },
        { title, brief: '', body: '', departmentId: dev!.id, productId, parentId: parent?.id ?? null, assigneeAgentId: executor, executor: true, gates: [], inTurnReview: true },
      )
    ).task;

  const merged = async (executor: string, taskId: string) => {
    await submit(ctx, executor, taskId, { summary: 'Done.', evidence: 'npm test' });
    return submit(ctx, executor, taskId, { summary: 'Merged into turn-4.', evidence: 'git log: 1a2b3c4' });
  };

  let n = 0;
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db
      .insert(jobs)
      .values({ companyId, subscriptionId: claude!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };

  return { app, ctx, db, companyId, ceoToken, claude: claude!, dev: dev!, sales: sales!, turn: turn ?? null, head, bruno, kai, rita, rex, sid, parent, member, merged, tools };
}

describe('GET /api/departments/:id/tree', () => {
  it('lists member tasks with agents, part, mergedAt after a merge, and the turn review with reviewers and findings', async () => {
    const { app, ctx, db, ceoToken, dev, turn, head, bruno, kai, rita, rex, sid, parent, member, merged, tools } = await company();
    const api = await member(bruno.id, 'Checkout API');
    const page = await member(kai.id, 'Checkout page');

    await merged(bruno.id, api.id);
    await merged(kai.id, page.id);

    const [review] = await db.select().from(tasks).where(and(eq(tasks.departmentId, dev.id), eq(tasks.title, 'Review of turn 4')));
    await (await tools(rita)).callTool({ name: 'verdict', arguments: { task: review!.number, pass: false, comment: 'Two issues.', findings: 2 } });
    await verdict(ctx, rex.id, review!.id, { pass: true, comment: 'Clean.' });

    const res = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(ceoToken) });
    expect(res.statusCode).toBe(200);
    const { tree } = res.json<{ tree: DepartmentTree }>();

    expect(tree.repository).toBe(true);
    expect(tree.turn).toEqual({
      id: turn!.id,
      number: 4,
      branch: 'turn-4',
      startedAt: turn!.openedAt!.toISOString(),
    });
    expect(tree.stage).toBe('review');
    expect(tree.lines.map(l => [l.title, l.agent.name, l.part?.id, l.branch])).toEqual([
      ['Checkout API', 'Bruno', parent!.id, `task-${api.number}`],
      ['Checkout page', 'Kai', parent!.id, `task-${page.number}`],
    ]);
    expect(tree.lines[0]!.mergedAt).not.toBeNull();
    expect(tree.lines[0]!.doneAt).toBeNull();
    expect(tree.lines[1]!.mergedAt).not.toBeNull();

    expect(tree.review).not.toBeNull();
    expect(tree.review!.head).toEqual({ id: head.id, name: 'Hana' });
    const byReviewer = new Map(tree.review!.reviewers.map(r => [r.agent.id, r.verdict]));
    expect(byReviewer.get(rita.id)).toMatchObject({ pass: false, findings: 2 });
    expect(byReviewer.get(rex.id)).toMatchObject({ pass: true, findings: null });
    expect(byReviewer.get(sid.id)).toBeNull();
  });

  it('ends a line in a stall from the agent event timestamp when a job had an agent event 40 minutes ago and nothing since', async () => {
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
    expect(tree.lines).toHaveLength(1);
    const line = tree.lines[0]!;
    expect(line.live).toBe(true);
    expect(line.lastActionAt).toBe(fortyAgo.toISOString());
    expect(line.segments).toEqual([
      { kind: 'work', from: sixtyAgo.toISOString(), to: fortyAgo.toISOString() },
      { kind: 'stall', from: fortyAgo.toISOString(), to: null },
    ]);
  });

  it('returns 404 when a person only reaches another department, or for a product or unknown id, and filters lines by product access', async () => {
    const { app, db, companyId, ceoToken, dev, sales, bruno, kai, member } = await company();
    const [shop] = await db.insert(departments).values({ companyId, parentId: dev.id, name: 'Shop', roleCode: 'DEV' }).returning();
    const [other] = await db.insert(departments).values({ companyId, parentId: dev.id, name: 'Backoffice', roleCode: 'DEV' }).returning();

    await member(bruno.id, 'Shop checkout', { productId: shop!.id });
    await member(kai.id, 'Backoffice export', { productId: other!.id });

    const expected404 = { error: { code: 'not_found', message: 'This department does not exist.', reason: 'department_unknown' } };
    const salesPerson = await invitePerson(app, ceoToken, { name: 'Sasha', email: 'sasha@acme.com', access: { departments: [sales.id] } });
    const denied = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(salesPerson) });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(expected404);

    const onProduct = await app.inject({ method: 'GET', url: `/api/departments/${shop!.id}/tree`, ...as(ceoToken) });
    expect(onProduct.statusCode).toBe(404);
    expect(onProduct.json()).toEqual(expected404);

    const onUnknown = await app.inject({ method: 'GET', url: `/api/departments/${randomUUID()}/tree`, ...as(ceoToken) });
    expect(onUnknown.statusCode).toBe(404);
    expect(onUnknown.json()).toEqual(expected404);

    const shopPerson = await invitePerson(app, ceoToken, { name: 'Polina', email: 'polina@acme.com', access: { departments: [shop!.id] } });
    const scoped = await app.inject({ method: 'GET', url: `/api/departments/${dev.id}/tree`, ...as(shopPerson) });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json<{ tree: DepartmentTree }>().tree.lines.map(l => l.title)).toEqual(['Shop checkout']);
  });

  it('returns turn null and empty lists when there is no open turn, and runs a fixed number of queries across line counts', async () => {
    const none = await company({ openTurn: false });
    const emptyRes = await none.app.inject({ method: 'GET', url: `/api/departments/${none.dev.id}/tree`, ...as(none.ceoToken) });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json<{ tree: DepartmentTree }>().tree).toMatchObject({
      turn: null,
      repository: true,
      stage: 'work',
      lines: [],
      review: null,
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
    expect(fourRes.json<{ tree: DepartmentTree }>().tree.lines).toHaveLength(4);
    expect(seen.length).toBe(countWithOneLine);
  });
});
