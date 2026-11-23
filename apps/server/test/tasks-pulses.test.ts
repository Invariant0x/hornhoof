import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import type { StreamMessage } from '../src/modules/events/bus.js';
import { answer, ask, cancel, createTask, report, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { setUpCompany, testApp, echelonsTurn } from './helpers.js';
import { recorded } from './recorded-fixture.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const heard: StreamMessage[] = [];
  app.ctx.bus.subscribe(companyId, m => heard.push(m));
  /* The pulses since the last look, as from -> to. */
  const pulses = () => {
    const seen = heard.splice(0).flatMap(m => (m.type === 'pulse' ? [[m.from, m.to]] : []));
    return seen.map(([from, to]) => [from, to].map(e => (e!.kind === 'orchestrator' ? 'orchestrator' : `${e!.kind}:${e!.id}`)).join(' -> '));
  };
  await echelonsTurn(db, companyId);
  return { ctx: app.ctx, CEO: { personId: ceo!.id }, ceo: ceo!, orchestrator: orchestrator!, dev: dev!, head, bruno, rita, pulses };
}

describe('pulses on the map for tasks', () => {
  it('runs from the orchestrator to the department he gives a task, and back when its head reports', async () => {
    const { ctx, orchestrator, dev, head, pulses } = await company();
    const { task } = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Icons', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    expect(pulses()).toEqual([`orchestrator -> department:${dev.id}`]);
    await report(ctx, head.id, task.id, { done: true, summary: 'Shipped.', ...(await recorded(ctx, task.id, head.id)) });
    expect(pulses()).toEqual([`department:${dev.id} -> orchestrator`]);
  });

  it("runs from a person to the department they give a task, and to the orchestrator for a turn", async () => {
    const { ctx, CEO, ceo, orchestrator, dev, head, pulses } = await company();
    await createTask(ctx, CEO, { title: 'Icons', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    await createTask(ctx, CEO, { title: 'Turn 1: icons', brief: '', body: '', departmentId: null, assigneeAgentId: orchestrator.id });
    expect(pulses()).toEqual([`person:${ceo.id} -> department:${dev.id}`, `person:${ceo.id} -> orchestrator`]);
  });

  it('runs moves inside one department from agent to agent, for its card and not the map', async () => {
    const { ctx, CEO, dev, head, bruno, rita, pulses } = await company();
    const parent = (await createTask(ctx, CEO, { title: 'Icons', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task;
    pulses();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Chips', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id });
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'Changed total tests.', review: { baseCommit: BASE } });
    await cancel(ctx, { agentId: head.id }, task.id, 'Not needed.');
    expect(pulses()).toEqual([`agent:${head.id} -> agent:${bruno.id}`, `agent:${bruno.id} -> agent:${rita.id}`]);
  });

  it('runs to the owner when an employee waits for people, and back with the answer', async () => {
    const { ctx, CEO, ceo, dev, head, bruno, pulses } = await company();
    const parent = (await createTask(ctx, CEO, { title: 'Icons', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task;
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Chips', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true });
    pulses();
    const { request } = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Round or square?' });
    expect(pulses()).toEqual([`department:${dev.id} -> person:${ceo.id}`]);
    await answer(ctx, { personId: ceo.id }, request.id, { answer: 'Round.' });
    expect(pulses()).toEqual([`person:${ceo.id} -> department:${dev.id}`]);
  });
});
