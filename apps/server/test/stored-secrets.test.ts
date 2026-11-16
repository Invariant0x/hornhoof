import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agentInbox, agents, attachments, departments, jobs, people, taskEvents, tasks } from '../src/db/schema.js';
import { createTask, comment } from '../src/modules/tasks/engine.js';
import { appendEvent } from '../src/modules/events/store.js';
import { keepMail } from '../src/modules/conversation/inbox.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, db, ceo, agent: agent!, companyId: agent!.companyId };
}

describe('secrets in stored prose', () => {
  it('masks tasks and comments before storing their copies', async () => {
    const { app, db, agent } = await company();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Login', brief: 'password=taskValue123!', body: 'пароль: taskBody987!', departmentId: null, assigneeAgentId: agent.id });
    await comment(app.ctx, { agentId: agent.id }, task.id, 'password=commentValue123!');
    const records = JSON.stringify([await db.select().from(tasks), await db.select().from(taskEvents), await db.execute(sql`select * from net.journal`)]);
    for (const secret of ['taskValue123!', 'taskBody987!', 'commentValue123!']) expect(records).not.toContain(secret);
    expect((await db.select().from(tasks))[0]!.body).toBe('пароль: [hidden]');
  });

  it('masks nested chat events, letters and queued prompts', async () => {
    const { app, db, agent, companyId } = await company();
    const data = { text: 'password=chatValue123!', nested: ['ghp_testKey0123456789'] };
    const event = await appendEvent(app.ctx, { companyId, agentId: agent.id, kind: 'text', data });
    expect(event.data).toEqual({ text: 'password=[hidden]', nested: ['[hidden]'] });
    const [job] = await db.insert(jobs).values({ companyId, agentId: agent.id, kind: 'conversation', prompt: '', subscriptionId: agent.subscriptionId!, timeoutMs: 1000 }).returning();
    await keepMail(db, { companyId, agentId: agent.id, message: { personId: null, text: 'пароль: mailValue123!' } }, job!.id, 'unread');
    await insertTurn(app.ctx, { companyId, agentId: agent.id, prompt: 'password=queuedValue123!', createdBy: null, message: { personId: null, text: 'password=queuedValue123!' } });
    const records = JSON.stringify([await db.select().from(agentEvents), await db.select().from(agentInbox), await db.select().from(jobs), await db.execute(sql`select * from net.journal`)]);
    for (const secret of ['chatValue123!', 'ghp_testKey0123456789', 'mailValue123!', 'queuedValue123!']) expect(records).not.toContain(secret);
  });

  it('hides an existing selection from tasks, nested copies, journals and API responses', async () => {
    const { app, db, agent, companyId, ceo } = await company();
    const marker = 'oldUniqueMarker_1077!';
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: marker, departmentId: null, assigneeAgentId: agent.id });
    await comment(app.ctx, { agentId: agent.id }, task.id, `copy ${marker}`);
    await appendEvent(app.ctx, { companyId, agentId: agent.id, kind: 'text', data: { text: marker, nested: [{ [marker]: marker }] } });
    await db.insert(attachments).values({ companyId, taskId: task.id, agentId: agent.id, name: 'old-comment.txt', mediaType: 'text/plain', bytes: Buffer.from(marker), size: Buffer.byteLength(marker) });
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(marker);
    const tables = await db.execute<{ name: string }>(sql`select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'net') order by 1`);
    for (const { name } of tables.rows) {
      const records = await db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`));
      expect(JSON.stringify(records.rows), name).not.toContain(marker);
    }
    /* A stale merge/input must not restore the old selection. */
    await db.update(tasks).set({ body: marker }).where(eq(tasks.id, task.id));
    expect((await db.select().from(tasks))[0]!.body).toBe('[hidden]');
    expect((await app.inject({ url: `/api/tasks/${task.id}`, ...as(ceo) })).body).not.toContain(marker);
    expect(Buffer.from((await db.select().from(attachments))[0]!.bytes).toString()).toBe('[hidden]');
  });

  it('checks department authority on the server and rejects ordinary readers', async () => {
    const { app, db, agent, companyId, ceo } = await company();
    const [dev, sales] = await db.insert(departments).values([
      { companyId, templateKey: 'development', roleCode: 'DEV' },
      { companyId, templateKey: 'sales', roleCode: 'SAL' },
    ]).returning();
    const owner = await invitePerson(app, ceo, { name: 'Department', email: 'department@acme.test', access: { departments: [dev!.id] } });
    const other = await invitePerson(app, ceo, { name: 'Elsewhere', email: 'elsewhere@acme.test', access: { departments: [sales!.id] } });
    const reader = await invitePerson(app, ceo, { name: 'Reader', email: 'reader@acme.test', access: { whole: true } });
    const deputy = await invitePerson(app, ceo, { name: 'Deputy', email: 'deputy@acme.test', access: { whole: true } });
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'deputy@acme.test'));
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: 'departmentSecret1077! deputySecret1077!', departmentId: dev!.id, assigneeAgentId: agent.id });
    const hide = (token: string, value: string) => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(token), payload: { value } });
    expect((await hide(reader, 'departmentSecret1077!')).statusCode).toBe(403);
    expect((await hide(other, 'departmentSecret1077!')).statusCode).toBe(403);
    expect((await hide(owner, 'departmentSecret1077!')).statusCode).toBe(200);
    expect((await hide(deputy, 'deputySecret1077!')).statusCode).toBe(200);
    expect((await hide(ceo, 'absentSecret1077!')).statusCode).toBe(400);
    expect((await db.select().from(taskEvents)).filter(e => e.data?.secretHidden)).toHaveLength(2);
  });

  it('never changes service state when the selected secret is a common word', async () => {
    const { app, db, agent, ceo } = await company();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: 'active', departmentId: null, assigneeAgentId: agent.id });
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: 'active' } });
    expect(response.statusCode, response.body).toBe(200);
    expect((await db.select().from(people)).every(person => person.status === 'active')).toBe(true);
  });

  it('keeps the mask stable even when the selection occurs within its spelling', async () => {
    const { app, db, agent, ceo } = await company();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: 'hid', departmentId: null, assigneeAgentId: agent.id });
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: 'hid' } });
    expect(response.statusCode, response.body).toBe(200);
    await db.update(tasks).set({ body: '[hidden]' }).where(eq(tasks.id, task.id));
    expect((await db.select().from(tasks))[0]!.body).toBe('[hidden]');
  });

  it('cleans an archived comment and lets a person select its full saved text', async () => {
    const { app, db, agent, ceo } = await company();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old note', brief: '', body: '', departmentId: null, assigneeAgentId: agent.id });
    const marker = 'старый🔑Unique1077!';
    await comment(app.ctx, { agentId: agent.id }, task.id, `${'ordinary prose '.repeat(400)}${marker}`);
    await comment(app.ctx, { agentId: agent.id }, task.id, `${'ordinary prose '.repeat(400)}password=archiveValue1077!`);
    const before = await db.select().from(attachments);
    expect(before).toHaveLength(2);
    expect(before.map(file => Buffer.from(file.bytes).toString()).join('')).not.toContain('archiveValue1077!');
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
    expect(response.statusCode, response.body).toBe(200);
    for (const file of await db.select().from(attachments)) expect(Buffer.from(file.bytes).toString()).not.toContain(marker);
  });
});
