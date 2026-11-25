import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, pendingWakes, tasks, turns } from '../src/db/schema.js';
import { giveTasks } from '../src/modules/tasks/turns.js';
import { as, invitePerson } from './helpers.js';
import { released } from './turn-tag-close-fixture.js';

/* How a department's next turn starts, and when it stands. Automatic: the turn that opens after a release takes the queue in
   by itself. Manual: it opens waiting, nobody is given work, until a person confirms it. From the cut of the release branch
   to the tag, the batch is frozen: nothing joins it. The hotfix lane, urgent work, goes past all of it. */

async function slotted(mode: 'automatic' | 'manual' = 'automatic', options: { queue?: number } = {}) {
  const f = await released();
  const departmentId = f.task.departmentId!;
  const companyId = f.task.companyId;
  const [head] = await f.db.select().from(agents).where(eq(agents.id, f.head.id));
  await f.db.insert(agents).values({ companyId, kind: 'worker', name: 'Solo', roleKey: 'DEV-BE', departmentId, model: '', subscriptionId: head!.subscriptionId });
  await f.db.update(departments).set({ slotCap: 2, turnStart: mode }).where(eq(departments.id, departmentId));
  const [orchestrator] = await f.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const give = (...items: { title: string; urgent?: boolean; small?: boolean }[]) =>
    giveTasks(f.ctx, { companyId, agentId: orchestrator!.id, jobId: crypto.randomUUID() }, items.map(i => ({ department: departmentId, brief: 'x', body: '', ...i })));
  const row = async (title: string) => (await f.db.select().from(tasks).where(eq(tasks.title, title)))[0]!;
  for (let n = 1; n <= (options.queue ?? 0); n++) {
    await f.db.insert(tasks).values({ companyId, number: 9000 + n, title: `Waiting ${n}`, departmentId, queuedAt: new Date(Date.now() + n) });
  }
  const wakesOf = async (title: string) => (await f.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, (await row(title)).id))).map(w => [w.agentId, w.why]);
  const turnOf = async (id: string) => (await f.db.select().from(turns).where(eq(turns.id, id)))[0]!;
  return { ...f, departmentId, give, row, wakesOf, turnOf };
}

describe('a department that starts its next turn by itself', () => {
  it('opens the turn started and takes the queue in, as it always did', async () => {
    const f = await slotted('automatic', { queue: 1 });
    await f.round();
    const next = await f.open();
    expect(next.confirmedAt).toBeInstanceOf(Date);
    expect(await f.row('Waiting 1')).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
  });
});

describe('a department that starts its next turn only when a person confirms', () => {
  it('opens the turn waiting, gives no one the queue, and shows the turn as waiting to people', async () => {
    const f = await slotted('manual', { queue: 1 });
    await f.round();
    const next = await f.open();
    expect(next.number).toBeGreaterThan(f.turn.number);
    expect(next.confirmedAt).toBeNull();
    expect(await f.row('Waiting 1')).toMatchObject({ assigneeAgentId: null });
    expect((await f.row('Waiting 1')).queuedAt).toBeInstanceOf(Date);
    expect(await f.wakesOf('Waiting 1')).toEqual([]);
    const view = (await f.app.inject({ method: 'GET', url: `/api/turns/current?department=${f.departmentId}`, ...as(f.ceoToken) })).json().turn;
    expect(view).toMatchObject({ number: next.number, waiting: true, canStart: true });
  });

  it('makes a new task wait in the queue however many slots are free, and lets urgent work go past', async () => {
    const f = await slotted('manual');
    await f.round();
    const wait = await f.give({ title: 'Ordinary' });
    expect(wait.wakes).toEqual([]);
    expect(wait.text).toContain('waits until a person starts the turn');
    expect((await f.row('Ordinary')).queuedAt).toBeInstanceOf(Date);
    const urgent = await f.give({ title: 'Hotfix', urgent: true });
    expect(urgent.wakes.map(w => w.agentId)).toEqual([f.head.id]);
    expect(await f.row('Hotfix')).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
  });

  it('starts the turn when a person confirms it: the queue goes in, in order, and the turn is no longer waiting', async () => {
    const f = await slotted('manual', { queue: 3 });
    await f.round();
    const next = await f.open();
    const confirmed = await f.app.inject({ method: 'POST', url: `/api/turns/${next.id}/start`, ...as(f.ceoToken) });
    expect(confirmed.statusCode).toBe(200);
    expect((await f.turnOf(next.id)).confirmedAt).toBeInstanceOf(Date);
    expect(await f.row('Waiting 1')).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
    expect(await f.row('Waiting 2')).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
    expect(await f.row('Waiting 3')).toMatchObject({ assigneeAgentId: null });
    expect(await f.wakesOf('Waiting 1')).toEqual([[f.head.id, 'assigned']]);
    const again = await f.app.inject({ method: 'POST', url: `/api/turns/${next.id}/start`, ...as(f.ceoToken) });
    expect(again.statusCode).toBe(409);
  });

  it('shows the start to a person who runs the department only, and refuses one who has the company turns but not this department', async () => {
    const f = await slotted('manual');
    await f.round();
    const next = await f.open();
    const [other] = await f.db.insert(departments).values({ companyId: f.task.companyId, templateKey: 'marketing', roleCode: 'MKT', position: 9 }).returning();
    const maria = await invitePerson(f.app, f.ceoToken, { name: 'Maria', email: 'maria@acme.com', access: { departments: [other!.id] } });
    const turnOf = async (token: string) => ((await f.app.inject({ method: 'GET', url: '/api/turns', ...as(token) })).json().turns as { id: string; waiting: boolean; canStart: boolean }[]).find(t => t.id === next.id);
    expect(await turnOf(maria)).toMatchObject({ waiting: true, canStart: false });
    expect(await turnOf(f.ceoToken)).toMatchObject({ waiting: true, canStart: true });
    const refused = await f.app.inject({ method: 'POST', url: `/api/turns/${next.id}/start`, ...as(maria) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('turn_start_not_allowed');
    expect((await f.turnOf(next.id)).confirmedAt).toBeNull();
  });

  it('starts at once a turn that waits when the department is set to start its turns by itself', async () => {
    const f = await slotted('manual', { queue: 1 });
    await f.round();
    const next = await f.open();
    const set = await f.app.inject({ method: 'PUT', url: `/api/departments/${f.departmentId}/turn-start`, payload: { mode: 'automatic' }, ...as(f.ceoToken) });
    expect(set.statusCode).toBe(200);
    expect((await f.turnOf(next.id)).confirmedAt).toBeInstanceOf(Date);
    expect(await f.row('Waiting 1')).toMatchObject({ assigneeAgentId: f.head.id, queuedAt: null });
  });

  it('lets only the people who run the department confirm, and a turn that is not waiting is not confirmed twice', async () => {
    const f = await slotted('manual');
    await f.round();
    const next = await f.open();
    const nobody = await f.app.inject({ method: 'POST', url: `/api/turns/${next.id}/start` });
    expect(nobody.statusCode).toBe(401);
    expect((await f.turnOf(next.id)).confirmedAt).toBeNull();
  });
});

describe('the way a department starts its turns', () => {
  it('is set by the people who run the department, to automatic or manual and nothing else', async () => {
    const f = await slotted('automatic');
    const set = (mode: unknown, who: { cookies?: { hh_session: string } } = as(f.ceoToken)) => f.app.inject({ method: 'PUT', url: `/api/departments/${f.departmentId}/turn-start`, payload: { mode }, ...who });
    expect((await set('manual')).statusCode).toBe(200);
    expect((await f.db.select().from(departments).where(eq(departments.id, f.departmentId)))[0]!.turnStart).toBe('manual');
    expect((await set('sometimes')).statusCode).toBe(400);
    expect((await set('automatic', {})).statusCode).toBe(401);
    expect((await f.db.select().from(departments).where(eq(departments.id, f.departmentId)))[0]!.turnStart).toBe('manual');
  });

  it('starts a new Development department in manual, and leaves any other department automatic', async () => {
    const { turnStartOfNew } = await import('../src/modules/tasks/slots.js');
    expect(turnStartOfNew('development')).toBe('manual');
    expect(turnStartOfNew('marketing')).toBe('automatic');
    expect(turnStartOfNew(null)).toBe('automatic');
  });
});

/* The turn is still open: the tag the fixture made is taken away until a test puts it back. */
async function beforeTheTag() {
  const f = await slotted('automatic');
  delete f.repo.tags['v1.7.0'];
  return { ...f, tag: () => { f.repo.tags['v1.7.0'] = f.commit; } };
}

describe('the cut of the release branch freezes the batch', () => {
  it('marks the open turn cut when a release branch of a newer version than its base appears, and not for another branch', async () => {
    const f = await beforeTheTag();
    for (const branch of ['release-1.6.0', 'release-1.7.0-review-a', 'release-cand-2066', 'turn-1']) f.repo.heads[branch] = f.commit;
    await f.round();
    expect((await f.open()).cutAt).toBeNull();
    f.repo.heads['release-1.7.0'] = f.commit;
    await f.round();
    const cut = await f.open();
    expect(cut.cutAt).toBeInstanceOf(Date);
    expect(cut.cutBranch).toBe('release-1.7.0');
  });

  it('keeps a task out of the batch from the cut on: a new task and a small addition wait, urgent work goes past', async () => {
    const f = await beforeTheTag();
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(and(eq(tasks.departmentId, f.departmentId), eq(tasks.status, 'open')));
    f.repo.heads['release-1.7.0'] = f.commit;
    await f.round();
    expect((await f.open()).cutAt).toBeInstanceOf(Date);
    const late = await f.give({ title: 'Late' }, { title: 'Late small', small: true });
    expect(late.wakes).toEqual([]);
    expect((await f.row('Late')).queuedAt).toBeInstanceOf(Date);
    expect((await f.row('Late small')).queuedAt).toBeInstanceOf(Date);
    const urgent = await f.give({ title: 'Patch', urgent: true });
    expect(urgent.wakes.map(w => w.agentId)).toEqual([f.head.id]);
  });

  it('freezes with a slot still unfinished, since the cut is the moment, not the last slot landing', async () => {
    const f = await beforeTheTag();
    const unfinished = await f.give({ title: 'Still going' });
    expect(unfinished.wakes).toHaveLength(1);
    f.repo.heads['release-1.7.0'] = f.commit;
    await f.round();
    expect((await f.open()).cutAt).toBeInstanceOf(Date);
    expect((await f.give({ title: 'After the cut' })).wakes).toEqual([]);
    expect(await f.row('Still going')).toMatchObject({ queuedAt: null, status: 'open' });
  });

  it('is over with the tag: the turn that opens is not cut', async () => {
    const f = await beforeTheTag();
    f.repo.heads['release-1.7.0'] = f.commit;
    await f.round();
    const cut = await f.open();
    expect(cut.cutAt).toBeInstanceOf(Date);
    f.tag();
    await f.round();
    const next = await f.open();
    expect(next.id).not.toBe(cut.id);
    expect(next.cutAt).toBeNull();
    expect((await f.turnOf(cut.id)).status).toBe('closed');
  });
});
