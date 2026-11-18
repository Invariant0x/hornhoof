import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { idOnly } from '../src/db/selections.js';
import { addNote, companyBook, departmentBook } from '../src/modules/notebook/book.js';
import { agents, attachments, departments, improvements, jobs, machines, proposals, tasks, testParts, testRuns, turns } from '../src/db/schema.js';
import { REQUIRED_OPERATIONS_ROLES } from '../src/modules/operations/required.js';
import { appendEvent } from '../src/modules/events/store.js';
import { ask, comment } from '../src/modules/tasks/engine.js';
import { as, openStream, until } from './helpers.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';
import { SERVER_MACHINE_ENV, serverMachine } from './helpers-computer.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('what waits for people', () => {
  const question = (c: AclCompany, agent: { id: string }, taskId: string, text: string) => ask(c.app.ctx, agent.id, taskId, { text, kind: 'question', topic: 'task' });
  /* What Olga's department policy asks her to approve, from an agent of her department on Bob's plan. As a question about
     its work, it is Ann's too, who is of the department and does not see that agent. */
  async function approval(c: AclCompany, kind: 'approval' | 'question' = 'approval') {
    const task = await c.work('Secret launch', c.crew.other);
    const asked = kind === 'approval' ? { kind, approval: { channel: 'spend' as const, kind: 'ads', amount: 12 } } : { kind, topic: 'task' as const };
    const { request } = await ask(c.app.ctx, c.crew.other.id, task.id, { text: 'May this go out?', ...asked, link: 'https://x.test/task-secret' });
    const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.other.id, requestId: request.id, name: 'shot.png', mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
    const [neighbour] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.other.id, taskId: task.id, name: 'neighbour.bin', mediaType: 'application/octet-stream', bytes: PNG, size: PNG.length }).returning();
    return { task, request, picture: picture!, neighbour: neighbour! };
  }
  const answer = (c: AclCompany, id: string, token: string, payload: object) => c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload, ...as(token) });
  const taskWords = (task: { id: string; number: number; title: string }) => [task.id, task.title, `task-${task.number}`, `#${task.number}`];

  it('shows a request of a seen agent with its task, and none of a hidden one the person may not answer', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const far = await c.work('Far work', c.crew.far, c.sales.id);
    await question(c, c.crew.mine, own.id, 'Please look');
    const hidden = (await question(c, c.crew.far, far.id, 'Please pick')).request;
    const res = await c.get('/api/requests', c.tokens.ann);
    expect(res.statusCode).toBe(200);
    expect(res.json().requests.map((r: { text: string }) => r.text)).toEqual(['Please look']);
    expect(res.json().requests[0]).toMatchObject({ agent: { id: c.crew.mine.id, name: 'Mina' }, task: { id: own.id } });
    expect(res.json().addressed).toEqual([]);
    expect(leaks(res, [c.crew.far])).toEqual([]);
    expect(res.body).not.toContain('Please pick');
    expect((await answer(c, hidden.id, c.tokens.ann, { answer: 'Mine now' })).statusCode).toBe(403);
  });

  it('gives the owner of a department a decision of its employee on another\'s plan with its task and agent, as she sees them all', async () => {
    const c = await aclCompany();
    const { task, request, picture } = await approval(c);
    const res = await c.get('/api/requests', c.tokens.olga);
    expect(res.statusCode).toBe(200);
    expect(res.json().addressed).toEqual([]);
    expect(res.json().requests).toMatchObject([{ id: request.id, kind: 'approval', canAnswer: true, ownerPersonId: c.ids.olga, images: [picture.id], agent: { id: c.crew.other.id, name: 'Otto' }, task: { id: task.id } }]);
    expect(res.json().counts.total).toBe(1);
    expect(res.json().counts.byAgent).toEqual({ [c.crew.other.id]: 1 });
    expect((await c.get(`/api/tasks/${task.id}`, c.tokens.olga)).statusCode).toBe(200);
    expect((await answer(c, request.id, c.tokens.olga, { approve: true })).json().request).toMatchObject({ id: request.id, status: 'approved' });
  });

  it('gives a decision of a hidden agent by a whitelist to a person of its department, with no task and no agent', async () => {
    const c = await aclCompany();
    const { task, request, picture } = await approval(c, 'question');
    const res = await c.get('/api/requests', c.tokens.ann);
    expect(res.statusCode).toBe(200);
    expect(res.json().requests).toEqual([]);
    const [line, ...rest] = res.json().addressed;
    expect(rest).toEqual([]);
    expect(Object.keys(line).sort()).toEqual(['approval', 'at', 'canAnswer', 'commit', 'decidedBy', 'id', 'images', 'kind', 'options', 'ownerPersonId', 'text'].sort());
    expect(line).toMatchObject({ id: request.id, kind: 'question', text: 'May this go out?', canAnswer: true, ownerPersonId: c.ids.olga, images: [picture.id], approval: null, commit: null });
    expect(leaks(res, [c.crew.other, c.crew.head])).toEqual([]);
    for (const word of [...taskWords(task), 'task-secret']) expect(res.body).not.toContain(word);
    expect(res.json().counts.byAgent).toEqual({});
  });

  it("lets that person answer and read only its own picture, and nothing of the agent's own around it", async () => {
    const c = await aclCompany();
    const { task, request, picture, neighbour } = await approval(c, 'question');
    expect((await c.get(`/api/attachments/${picture.id}`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get(`/api/attachments/${neighbour.id}`, c.tokens.ann)).statusCode).toBe(404);
    /* The task is the company's, which everyone sees; the agent's window is not hers. */
    expect((await c.get(`/api/tasks/${task.id}`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get(`/api/agents/${c.crew.other.id}`, c.tokens.ann)).statusCode).toBe(403);
    expect((await c.get(`/api/agents/${c.crew.other.id}/events`, c.tokens.ann)).statusCode).toBe(403);
    const list = (await c.get(`/api/tasks?status=all&department=${c.dev.id}`, c.tokens.ann)).body;
    expect(list).toContain(task.title);
    /* The stream listens from the moment it answers: the server takes the bus in the same step it sends the headers. */
    const stream = await openStream(c.app, c.tokens.ann);
    const answered = await answer(c, request.id, c.tokens.ann, { answer: 'This way' });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().request).toMatchObject({ id: request.id, status: 'answered' });
    for (const word of taskWords(task)) expect(answered.body).not.toContain(word);
    expect(leaks(answered, [c.crew.other, c.crew.head])).toEqual([]);
    c.app.ctx.bus.publish(c.companyId, { type: 'org' });
    await until(() => stream.messages.some(m => m.type === 'org'));
    expect(stream.messages.filter(m => m.type === 'agent_event')).toEqual([]);
    expect(JSON.stringify(stream.messages)).not.toContain('This way');
    stream.close();
    /* Answered, it is nobody's to take: gone from the list, no second answer, its picture closed to someone who only answered. */
    expect((await c.get('/api/requests', c.tokens.ann)).json().addressed).toEqual([]);
    const again = await answer(c, request.id, c.tokens.ann, { answer: 'That way' });
    expect(again.statusCode).toBe(409);
    for (const word of taskWords(task)) expect(again.body).not.toContain(word);
    expect((await c.get(`/api/attachments/${picture.id}`, c.tokens.ann)).statusCode).toBe(404);
  });

  it('takes the decision away from an owner who has the department no more', async () => {
    const c = await aclCompany();
    const { request, picture } = await approval(c);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.olga}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    expect((await c.get('/api/requests', c.tokens.olga)).json()).toMatchObject({ requests: [], addressed: [] });
    expect((await answer(c, request.id, c.tokens.olga, { approve: true })).statusCode).toBe(403);
    expect((await c.get(`/api/attachments/${picture.id}`, c.tokens.olga)).statusCode).toBe(404);
    /* With no owner left, the approval is the CEO's. */
    expect((await c.get('/api/requests', c.tokens.ceo)).json().requests.map((r: { id: string; canAnswer: boolean }) => [r.id, r.canAnswer])).toEqual([[request.id, true]]);
  });

  it('gives an outsider nothing of it: not to see, not to answer', async () => {
    const c = await aclCompany();
    const { request, picture } = await approval(c);
    for (const viewer of ['ann', 'wes'] as const) {
      const res = await c.get('/api/requests', c.tokens[viewer]);
      expect(res.json().requests).toEqual([]);
      expect(res.json().addressed).toEqual([]);
      expect(res.json().counts.total).toBe(0);
      expect(res.body).not.toContain('May this go out?');
      expect((await answer(c, request.id, c.tokens[viewer], { approve: true })).statusCode).toBe(403);
      expect((await c.get(`/api/attachments/${picture.id}`, c.tokens[viewer])).statusCode).toBe(404);
    }
  });

  it('keeps the whole request for the CEO and the delegate', async () => {
    const c = await aclCompany();
    const { task, request, picture } = await approval(c);
    for (const viewer of ['ceo', 'clara'] as const) {
      const res = (await c.get('/api/requests', c.tokens[viewer])).json();
      expect(res.addressed).toEqual([]);
      expect(res.requests[0]).toMatchObject({ id: request.id, agent: { id: c.crew.other.id, name: 'Otto' }, task: { id: task.id, title: task.title }, link: 'https://x.test/task-secret' });
      expect((await c.get(`/api/attachments/${picture.id}`, c.tokens[viewer])).statusCode).toBe(200);
    }
    expect((await answer(c, request.id, c.tokens.clara, { approve: true })).statusCode).toBe(200);
  });

  it('leaves the people of a department the decisions already theirs, by the same whitelist', async () => {
    const c = await aclCompany();
    const hiddenWork = await c.work('Hidden work', c.crew.other);
    const { request } = await question(c, c.crew.other, hiddenWork.id, 'Which way?');
    const res = await c.get('/api/requests', c.tokens.ann);
    expect(res.json().addressed.map((r: { id: string; canAnswer: boolean }) => [r.id, r.canAnswer])).toEqual([[request.id, true]]);
    expect(res.body).not.toContain(hiddenWork.title);
    expect((await answer(c, request.id, c.tokens.ann, { answer: 'This way' })).statusCode).toBe(200);
  });

  it('counts a request by a hidden agent on a task the person sees as theirs only when they may answer it', async () => {
    const c = await aclCompany();
    const { createTask } = await import('../src/modules/tasks/engine.js');
    const { task } = await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Shared work', brief: '', body: '', departmentId: c.dev.id, productId: c.product.id, assigneeAgentId: c.crew.far.id, executor: true, reviewerAgentId: c.crew.mine.id });
    await c.db.update(tasks).set({ createdByAgentId: c.crew.mine.id }).where(eq(tasks.id, task.id));
    const { request } = await ask(c.app.ctx, c.crew.far.id, task.id, { text: 'Costs money?', kind: 'approval', approval: { channel: 'spend', kind: 'ads', amount: 1 } });
    const ann = (await c.get('/api/requests', c.tokens.ann)).json();
    expect([ann.requests, ann.addressed]).toEqual([[], []]);
    const olga = (await c.get('/api/requests', c.tokens.olga)).json();
    expect(olga.addressed.map((r: { id: string }) => r.id)).toEqual([request.id]);
    expect(JSON.stringify(olga)).not.toContain('Shared work');
  });

  it("keeps the orchestrator's cards from anyone who does not see him", async () => {
    const c = await aclCompany(SERVER_MACHINE_ENV);
    await c.db.insert(proposals).values({ companyId: c.companyId, agentId: c.orchestrator.id, kind: 'staff', brief: 'Hire Zed', items: [], departmentId: c.dev.id });
    await serverMachine(c.app);
    const wes = await c.get('/api/requests', c.tokens.wes);
    expect(wes.json().proposals).toEqual([]);
    expect(wes.json().machineAccess).toEqual([]);
    expect(leaks(wes, [c.orchestrator])).toEqual([]);
    expect(wes.body).not.toMatch(/Hire Zed|Fix the disk/);
    for (const viewer of ['ceo', 'clara'] as const) {
      const full = (await c.get('/api/requests', c.tokens[viewer])).json();
      expect(full.proposals).toHaveLength(1);
      expect(full.machineAccess).toEqual([]);
    }
  });
});

describe('a long text kept as a file of its task', () => {
  const WORDS = 'Private long words. '.repeat(400).trim();
  type Detail = { task: { files: { id: string; by: { id: string; name: string } | null }[]; log: { text: string; data: { fullTexts?: { id: string }[] } }[] } };
  const fileOf = async (c: AclCompany, taskId: string) => {
    const [file] = await c.db.select(idOnly(attachments)).from(attachments).where(eq(attachments.taskId, taskId));
    return file!.id;
  };

  it('stays closed with a task the person does not see, and open to the full view', async () => {
    const c = await aclCompany();
    const task = await c.work('Hidden work', c.crew.other);
    await comment(c.app.ctx, { agentId: c.crew.other.id }, task.id, WORDS);
    const url = `/api/attachments/${await fileOf(c, task.id)}`;
    for (const token of [c.tokens.ann, c.tokens.wes]) {
      const res = await c.get(url, token);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('Private long words');
    }
    /* The owner of the department sees its every employee, and their work with them. */
    for (const token of [c.tokens.ceo, c.tokens.clara, c.tokens.olga]) expect((await c.get(url, token)).body).toBe(WORDS);
  });

  it('stays closed on a task the person sees when a hidden agent wrote it', async () => {
    const c = await aclCompany();
    const task = await c.work('Shared work', c.crew.mine);
    await comment(c.app.ctx, { agentId: c.crew.other.id }, task.id, WORDS);
    const file = await fileOf(c, task.id);
    expect((await c.get(`/api/attachments/${file}`, c.tokens.ann)).statusCode).toBe(404);
    const { task: detail } = (await c.get(`/api/tasks/${task.id}`, c.tokens.ann)).json<Detail>();
    expect(detail.files).toEqual([]);
    expect(JSON.stringify(detail.log)).not.toContain(file);
  });

  it('opens for the person who sees the agent who wrote it, with its link in the log', async () => {
    const c = await aclCompany();
    const task = await c.work('Own work', c.crew.mine);
    await comment(c.app.ctx, { agentId: c.crew.mine.id }, task.id, WORDS);
    const file = await fileOf(c, task.id);
    expect((await c.get(`/api/attachments/${file}`, c.tokens.ann)).body).toBe(WORDS);
    const { task: detail } = (await c.get(`/api/tasks/${task.id}`, c.tokens.ann)).json<Detail>();
    expect(detail.files.map(f => f.id)).toEqual([file]);
    expect(detail.log.find(l => l.data.fullTexts)?.data.fullTexts?.map(f => f.id)).toEqual([file]);
  });

  it("opens when a person wrote it on a task the person sees, though it is kept under a hidden agent", async () => {
    const c = await aclCompany();
    const task = await c.work('Held elsewhere', c.crew.other);
    await c.db.update(tasks).set({ executorAgentId: c.crew.mine.id }).where(eq(tasks.id, task.id));
    await comment(c.app.ctx, { personId: c.ids.bob }, task.id, WORDS);
    const file = await fileOf(c, task.id);
    expect((await c.get(`/api/attachments/${file}`, c.tokens.ann)).body).toBe(WORDS);
    const res = await c.get(`/api/tasks/${task.id}`, c.tokens.ann);
    expect(res.json<Detail>().task.files.map(f => [f.id, f.by?.id])).toEqual([[file, c.ids.bob]]);
  });

  it('answers to the request, not the task, for a picture sent to a task and shown with a request', async () => {
    const c = await aclCompany();
    const task = await c.work('Secret launch', c.crew.other);
    const { request } = await ask(c.app.ctx, c.crew.other.id, task.id, { text: 'May this go out?', kind: 'approval', approval: { channel: 'spend', kind: 'ads', amount: 1 } });
    const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.other.id, taskId: task.id, requestId: request.id, name: 'p.png', mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
    const shown = await c.get(`/api/attachments/${picture!.id}`, c.tokens.olga);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.ann)).statusCode).toBe(404);
  });
});

describe('a wait on a task', () => {
  const reason = 'Waiting for the reply';
  const wait = (on?: { kind: 'employee'; employee: string; name: string } | { kind: 'external'; event: 'time' }) => ({ reason, since: '2026-01-01T00:00:00.000Z', until: '2026-01-01T01:00:00.000Z', ...(on ? { on } : {}) });
  type Line = { id: string; externalWait: { reason: string; on?: unknown } | null };
  const readLines = async (c: AclCompany) => (await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ann)).json<{ tasks: Line[] }>().tasks;

  it('says whom it is on, any employee of the company, and an event', async () => {
    const c = await aclCompany();
    const onHidden = await c.work('On hidden', c.crew.mine);
    const onSeen = await c.work('On seen', c.crew.mine);
    const onEvent = await c.work('On event', c.crew.mine);
    const onNobody = await c.work('On nobody', c.crew.mine);
    await c.db.update(tasks).set({ externalWait: wait({ kind: 'employee', employee: c.crew.other.id, name: c.crew.other.name }) }).where(eq(tasks.id, onHidden.id));
    await c.db.update(tasks).set({ externalWait: wait({ kind: 'employee', employee: c.crew.mine.id, name: c.crew.mine.name }) }).where(eq(tasks.id, onSeen.id));
    await c.db.update(tasks).set({ externalWait: wait({ kind: 'external', event: 'time' }) }).where(eq(tasks.id, onEvent.id));
    await c.db.update(tasks).set({ externalWait: wait() }).where(eq(tasks.id, onNobody.id));
    const list = await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ann);
    const line = (id: string) => list.json<{ tasks: Line[] }>().tasks.find(t => t.id === id)!;
    expect(line(onHidden.id).externalWait?.on).toEqual({ kind: 'employee', employee: c.crew.other.id, name: c.crew.other.name });
    expect(line(onSeen.id).externalWait?.on).toEqual({ kind: 'employee', employee: c.crew.mine.id, name: c.crew.mine.name });
    expect(line(onEvent.id).externalWait?.on).toEqual({ kind: 'external', event: 'time' });
    expect(line(onNobody.id).externalWait).not.toHaveProperty('on');
    const detail = await c.get(`/api/tasks/${onHidden.id}`, c.tokens.ann);
    expect(detail.json<{ task: Line }>().task.externalWait?.on).toEqual({ kind: 'employee', employee: c.crew.other.id, name: c.crew.other.name });
  });

  it('goes with the agent who holds the task: their words are not for someone who sees only another agent on it', async () => {
    const c = await aclCompany();
    const task = await c.work('Held elsewhere', c.crew.other);
    await c.db.update(tasks).set({ executorAgentId: c.crew.mine.id, externalWait: wait() }).where(eq(tasks.id, task.id));
    expect((await readLines(c)).find(t => t.id === task.id)!.externalWait).toBeNull();
    expect((await c.get(`/api/tasks/${task.id}`, c.tokens.ceo)).json<{ task: Line }>().task.externalWait?.reason).toBe(reason);
    const unheld = await c.work('Nobody holds it', c.crew.mine);
    await c.db.update(tasks).set({ assigneeAgentId: null, executorAgentId: c.crew.mine.id, externalWait: wait() }).where(eq(tasks.id, unheld.id));
    expect((await readLines(c)).find(t => t.id === unheld.id)!.externalWait).toBeNull();
  });
});

describe('turns', () => {
  it('counts every task of the company for everyone and keeps the words the turn was laid out from for the full view', async () => {
    const c = await aclCompany();
    const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'Turn', status: 'open', messages: [{ by: 'Ivan', text: 'Secret plan', at: new Date().toISOString() }], openedAt: new Date() }).returning();
    const own = await c.work('Own work', c.crew.mine);
    const other = await c.work('Hidden work', c.crew.other);
    const { tasks } = await import('../src/db/schema.js');
    await c.db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, own.id));
    await c.db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, other.id));
    await c.db.update(turns).set({ taskId: other.id }).where(eq(turns.id, turn!.id));
    for (const viewer of ['ann', 'wes'] as const) {
      const res = await c.get('/api/turns/current', c.tokens[viewer]);
      expect(res.body).not.toContain('Secret plan');
      expect(res.json().turn).toMatchObject({ messages: [], taskId: other.id, tasks: { total: 2, done: 0 } });
      expect((await c.get('/api/turns', c.tokens[viewer])).body).not.toContain('Secret plan');
    }
    expect((await c.get('/api/turns/current', c.tokens.clara)).json().turn).toMatchObject({ taskId: other.id, tasks: { total: 2, done: 0 } });
    expect((await c.get('/api/turns/current', c.tokens.clara)).body).toContain('Secret plan');
  });
});

describe('plans, machines and the pool', () => {
  async function running(c: AclCompany) {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ids.wes, machineKey: 'wes-machine-12345', hostname: 'wes-box' }).returning();
    const put = async (agent: { id: string }, taskTitle: string, number: number) => {
      const task = await c.work(taskTitle, agent, c.dev.id);
      const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.plans.bob.id, agentId: agent.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
      const [run] = await c.db.insert(testRuns).values({ companyId: c.companyId, number, kind: 'tests', departmentId: c.dev.id, taskId: task.id, agentId: agent.id, jobId: job!.id, branch: 'main', command: 'echo ok', parts: 1, timeoutMs: 60_000, status: 'running' }).returning();
      await c.db.insert(testParts).values({ runId: run!.id, companyId: c.companyId, part: 1, status: 'running', machineId: machine!.id, startedAt: new Date() });
    };
    await put(c.crew.other, 'Otto run', 1);
    await put(c.crew.wide, 'Wanda run', 2);
    return machine!;
  }

  it('lists on a plan only the agents the person sees, also when it is their own plan elsewhere', async () => {
    const c = await aclCompany();
    const res = await c.get('/api/subscriptions', c.tokens.ann);
    const mine = res.json().subscriptions.find((s: { id: string }) => s.id === c.plans.ann.id);
    expect(mine.agents.map((a: { name: string; canOpen: boolean }) => [a.name, a.canOpen])).toEqual([['Mina', true]]);
    expect(leaks(res, [c.crew.away, c.crew.other, c.crew.far])).toEqual([]);
    const wide = await c.get('/api/subscriptions', c.tokens.wes);
    expect(wide.json().subscriptions.flatMap((s: { agents: { name: string }[] }) => s.agents.map(a => a.name))).toEqual(['Wanda']);
    const full = (await c.get('/api/subscriptions', c.tokens.clara)).json().subscriptions.flatMap((s: { agents: { canOpen: boolean }[] }) => s.agents);
    expect(full.length).toBeGreaterThan(8);
    expect(full.every((a: { canOpen: boolean }) => a.canOpen)).toBe(true);
  });

  it('runs on a machine name only agents the person sees', async () => {
    const c = await aclCompany();
    await running(c);
    const res = await c.get('/api/machines', c.tokens.wes);
    expect(res.statusCode).toBe(200);
    const box = res.json().machines.find((m: { hostname: string }) => m.hostname === 'wes-box');
    expect(box.running.parts.map((p: { agent: string }) => p.agent)).toEqual(['Wanda']);
    expect(res.body).not.toContain('Otto');
    const full = (await c.get('/api/machines', c.tokens.clara)).json().machines.find((m: { hostname: string }) => m.hostname === 'wes-box');
    expect(full.running.parts.map((p: { agent: string }) => p.agent).sort()).toEqual(['Otto', 'Wanda']);
  });

  it('shows in the pool only parts of agents the person sees', async () => {
    const c = await aclCompany();
    await running(c);
    const res = await c.get('/api/pool', c.tokens.wes);
    expect(res.statusCode).toBe(200);
    const box = res.json().machines.find((m: { name: string }) => m.name === 'wes-box');
    expect(box.parts.map((p: { agent: string }) => p.agent)).toEqual(['Wanda']);
    expect(res.body).not.toContain('Otto');
    const full = (await c.get('/api/pool', c.tokens.clara)).json().machines.find((m: { name: string }) => m.name === 'wes-box');
    expect(full.parts.map((p: { agent: string }) => p.agent).sort()).toEqual(['Otto', 'Wanda']);
  });
});

describe('notebooks', () => {
  it('keeps a note and leaves out the hidden agent who wrote it', async () => {
    const c = await aclCompany();
    await addNote(c.app.ctx, departmentBook(c.product), 'A note on the release', { personId: null, byOrchestrator: false, agentId: c.crew.other.id });
    await addNote(c.app.ctx, departmentBook(c.product), 'A note on the build', { personId: null, byOrchestrator: false, agentId: c.crew.mine.id });
    await addNote(c.app.ctx, companyBook(c.companyId), 'A note on sales', { personId: null, byOrchestrator: false, agentId: c.crew.wide.id });
    await addNote(c.app.ctx, companyBook(c.companyId), 'A note on prices', { personId: null, byOrchestrator: false, agentId: c.crew.other.id });
    const dev = await c.get(`/api/departments/${c.product.id}/notebook`, c.tokens.ann);
    expect(dev.json().notes.map((n: { by: unknown }) => n.by)).toEqual([null, { kind: 'agent', id: c.crew.mine.id, name: 'Mina' }]);
    expect(leaks(dev, [c.crew.other])).toEqual([]);
    const company = await c.get('/api/notebook', c.tokens.wes);
    expect(company.json().notes.map((n: { by: unknown }) => n.by)).toEqual([{ kind: 'agent', id: c.crew.wide.id, name: 'Wanda' }, null]);
    expect((await c.get(`/api/departments/${c.product.id}/notebook`, c.tokens.clara)).json().notes[0].by).toMatchObject({ id: c.crew.other.id });
  });
});

describe('improvements', () => {
  it('shows and lets decide only those of agents the person sees', async () => {
    const c = await aclCompany();
    const [own] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew.wide.id, title: 'Wanda idea', text: 'x' }).returning();
    const [other] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew.other.id, title: 'Otto idea', text: 'x' }).returning();
    const res = await c.get('/api/improvements', c.tokens.wes);
    expect(res.json().improvements.map((i: { id: string }) => i.id)).toEqual([own!.id]);
    expect(leaks(res, [c.crew.other])).toEqual([]);
    expect(res.body).not.toContain('Otto idea');
    expect((await c.app.inject({ method: 'POST', url: `/api/improvements/${other!.id}/dismiss`, ...as(c.tokens.wes) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `/api/improvements/${own!.id}/dismiss`, ...as(c.tokens.wes) })).statusCode).toBe(200);
    expect((await c.get('/api/improvements', c.tokens.clara)).json().improvements).toHaveLength(2);
    expect((await c.get('/api/improvements', c.tokens.ann)).statusCode).toBe(403);
  });

  it('names every linked task, as everyone sees the tasks of the company', async () => {
    const c = await aclCompany();
    const [own] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew.wide.id, title: 'Wanda idea', text: 'x' }).returning();
    const { taskEvents, tasks } = await import('../src/db/schema.js');
    const hidden = await c.work('Hidden from Wes', c.crew.other);
    const seen = await c.work('Wanda work', c.crew.wide, c.sales.id);
    await c.db.update(taskEvents).set({ data: { improvement: own!.id } }).where(eq(taskEvents.taskId, hidden.id));
    await c.db.update(taskEvents).set({ data: { improvement: own!.id } }).where(eq(taskEvents.taskId, seen.id));
    expect((await c.db.select().from(tasks)).length).toBeGreaterThan(1);
    const res = await c.get('/api/improvements', c.tokens.wes);
    expect(res.json().improvements[0].tasks.map((t: { id: string }) => t.id).sort()).toEqual([hidden.id, seen.id].sort());
  });
});

describe('jobs', () => {
  it('reads and cancels only a job of an agent the person sees', async () => {
    const c = await aclCompany();
    const job = async (agent: { id: string }) => (await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.plans.bob.id, agentId: agent.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'done', result: 'secret', finishedAt: new Date() }).returning())[0]!;
    const [own, other] = [await job(c.crew.wide), await job(c.crew.other)];
    expect((await c.get(`/api/jobs/${own.id}`, c.tokens.wes)).statusCode).toBe(200);
    const closed = await c.get(`/api/jobs/${other.id}`, c.tokens.wes);
    expect(closed.statusCode).toBe(403);
    expect(closed.body).not.toContain('secret');
    expect((await c.get(`/api/jobs/${other.id}`, c.tokens.ann)).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `/api/jobs/${other.id}/cancel`, ...as(c.tokens.wes) })).statusCode).toBe(403);
    expect((await c.get(`/api/jobs/${other.id}`, c.tokens.clara)).statusCode).toBe(200);
  });
});

describe('pictures', () => {
  it('opens a picture sent to an agent only to someone who sees that agent', async () => {
    const c = await aclCompany();
    const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.other.id, personId: c.ids.bob, name: 'shot.png', mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.bob)).statusCode).toBe(200);
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.clara)).statusCode).toBe(200);
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.olga)).statusCode).toBe(200);
    for (const viewer of ['ann', 'wes'] as const) expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens[viewer])).statusCode).toBe(404);
    expect((await c.get('/api/attachments/00000000-0000-4000-8000-000000000000', c.tokens.ann)).statusCode).toBe(404);
  });

  it('opens a picture of a request to whoever sees it or may answer it', async () => {
    const c = await aclCompany();
    const hiddenWork = await c.work('Hidden work', c.crew.other);
    const { request } = await ask(c.app.ctx, c.crew.other.id, hiddenWork.id, { text: 'Look', kind: 'question', topic: 'task' });
    const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.other.id, requestId: request.id, name: 'shot.png', mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.olga)).statusCode).toBe(200);
    expect((await c.get(`/api/attachments/${picture!.id}`, c.tokens.wes)).statusCode).toBe(404);
  });
});

describe('a department\'s staff', () => {
  it('keeps who holds a role from anyone without the full view', async () => {
    const c = await aclCompany();
    const res = await c.get(`/api/departments/${c.dev.id}/roster`, c.tokens.wes);
    expect(res.statusCode).toBe(200);
    expect(leaks(res, [c.crew.head, c.crew.other, c.crew.mine, c.crew.owned])).toEqual([]);
    expect(res.json().roles.every((r: { holder: string | null }) => r.holder === null)).toBe(true);
    const [ops] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'operations', roleCode: 'OPS', position: 3 }).returning();
    const role = REQUIRED_OPERATIONS_ROLES[1];
    await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Holder', roleKey: role, departmentId: ops!.id, model: '', subscriptionId: c.plans.bob.id });
    const held = async (token: string) => (await c.get(`/api/departments/${ops!.id}/roster`, token)).json().roles.find((r: { id: string }) => r.id === role).holder;
    expect(await held(c.tokens.clara)).toBe('Holder');
    expect(await held(c.tokens.wes)).toBeNull();
    /* Hiring is the CEO's and the delegate's, who see every head anyway. */
    const refused = await c.app.inject({ method: 'POST', url: `/api/departments/${c.dev.id}/staff`, payload: { people: [{ role: 'DEV-HEAD', name: 'Second head', model: '', subscription: c.plans.wes.id, skills: [], product: null }] }, ...as(c.tokens.wes) });
    expect(refused.statusCode).toBe(403);
    expect(leaks(refused, [c.crew.head])).toEqual([]);
  });
});

describe('the events of a seen agent', () => {
  it('name no hidden agent at the other end of a message', async () => {
    const c = await aclCompany();
    const party = (a: { id: string; name: string }) => ({ kind: 'agent' as const, id: a.id, name: a.name, role: null, department: null });
    await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.crew.mine.id, kind: 'message', data: { text: 'Do it' }, message: { direction: 'in', from: party(c.crew.other), to: party(c.crew.mine), senders: [party(c.crew.head)] } });
    const res = await c.get(`/api/agents/${c.crew.mine.id}/events`, c.tokens.ann);
    expect(res.statusCode).toBe(200);
    expect(leaks(res, [c.crew.other, c.crew.head])).toEqual([]);
    expect(res.json().events[0].message).toMatchObject({ from: { kind: 'agent', id: null, name: 'Employee' }, to: { id: c.crew.mine.id } });
    expect((await c.get(`/api/agents/${c.crew.mine.id}/events`, c.tokens.clara)).json().events[0].message.from.id).toBe(c.crew.other.id);
  });
});

describe('the computer', () => {
  it("shows standing access without any request", async () => {
    const c = await aclCompany(SERVER_MACHINE_ENV);
    await serverMachine(c.app);
    const wes = await c.get('/api/computer', c.tokens.wes);
    expect(wes.statusCode).toBe(200);
    expect(wes.json().asked).toBeNull();
    expect(wes.body).not.toContain('Fix the disk');
    expect((await c.get('/api/computer', c.tokens.clara)).json()).toMatchObject({ open: true, asked: null });
  });
});
