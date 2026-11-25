import { eq, sql } from 'drizzle-orm';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agentInbox, agents, attachments, companies, departments, jobs, people, secretRedactions, subscriptions, taskEvents, tasks, toolCalls } from '../src/db/schema.js';
import { createTask, comment } from '../src/modules/tasks/engine.js';
import { appendEvent } from '../src/modules/events/store.js';
import { keepMail } from '../src/modules/conversation/inbox.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { sha256Of, stored } from './files-fixture.js';
import { dropDue } from '../src/modules/files/sweep.js';

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

  it('keeps code and ordinary words of a task, a comment and a chat as they were written', async () => {
    const { app, db, agent, companyId } = await company();
    const prose = 'Review checks basic security. Authorization: Bearer header stays. const token = getToken(req); ?code=XYZ; password #267';
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Plain', brief: prose, body: prose, departmentId: null, assigneeAgentId: agent.id });
    await comment(app.ctx, { agentId: agent.id }, task.id, prose);
    const event = await appendEvent(app.ctx, { companyId, agentId: agent.id, kind: 'text', data: { text: prose } });
    expect(event.data).toEqual({ text: prose });
    expect((await db.select().from(tasks))[0]).toMatchObject({ brief: prose, body: prose });
    expect((await db.select().from(taskEvents)).filter(e => e.kind === 'comment').map(e => e.text)).toEqual([prose]);
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
    await db.insert(attachments).values({ companyId, taskId: task.id, agentId: agent.id, name: 'old-comment.txt', mediaType: 'text/plain', sha256: await stored(db, marker, app.ctx.config), size: Buffer.byteLength(marker) });
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(marker);
    const tables = await db.execute(sql`select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'net') order by 1`) as { rows: { name: string }[] };
    for (const { name } of tables.rows) {
      const records = await db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`)) as { rows: unknown[] };
      expect(JSON.stringify(records.rows), name).not.toContain(marker);
    }
    expect((await db.select().from(tasks))[0]!.body).toBe('[hidden]');
    expect((await app.inject({ url: `/api/tasks/${task.id}`, ...as(ceo) })).body).not.toContain(marker);
    /* The file is kept again as it reads now, and the store lets the one it was go at its next round. */
    const [file] = await db.select().from(attachments);
    expect([file!.sha256, file!.size, (await app.ctx.files.bytes(db, file!.sha256!)).toString()]).toEqual([sha256Of('[hidden]'), 8, '[hidden]']);
    await dropDue(app.ctx, new Date());
    expect(app.ctx.files.store().has(sha256Of(marker))).toBe(false);
    /* An old copy brings the value back only through a merge, which checks its rows against the fingerprint. */
    expect(await db.select().from(secretRedactions)).toEqual([expect.objectContaining({ characters: marker.length, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
  });

  it('never sends the selected value in SQL text or parameters', async () => {
    const { app, db, agent, companyId, ceo } = await company();
    const marker = 'sqlBoundarySecret1077!';
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Existing secret', brief: '', body: marker, departmentId: null, assigneeAgentId: agent.id });
    await appendEvent(app.ctx, { companyId, agentId: agent.id, kind: 'text', data: { text: marker } });
    const client = (db as unknown as { $client: PGlite }).$client;
    const queries = vi.spyOn(client, 'query');
    const statements = vi.spyOn(client, 'exec');
    const inside: unknown[][] = [];
    const transaction = client.transaction.bind(client);
    const transactions = vi.spyOn(client, 'transaction').mockImplementation(<T>(work: (tx: Transaction) => Promise<T>) => transaction(async tx => {
      const queries = vi.spyOn(tx, 'query');
      const statements = vi.spyOn(tx, 'exec');
      try {
        return await work(tx);
      } finally {
        inside.push(...queries.mock.calls, ...statements.mock.calls);
        queries.mockRestore();
        statements.mockRestore();
      }
    }));
    try {
      const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(marker);
      expect(inside.some(([text]) => typeof text === 'string' && text.includes('jsonb_populate_record'))).toBe(true);
      expect(JSON.stringify([...queries.mock.calls, ...statements.mock.calls, ...inside])).not.toContain(marker);
    } finally {
      queries.mockRestore();
      statements.mockRestore();
      transactions.mockRestore();
    }
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
    /* Seven characters of the task's text would be hidden in every text of the company. */
    const short = await hide(ceo, 'Secret1');
    expect([short.statusCode, short.json().error.message]).toEqual([400, 'Select a secret of at least 8 characters in this task or its log.']);
    expect(await db.select().from(secretRedactions)).toEqual([]);
    expect((await hide(reader, 'departmentSecret1077!')).statusCode).toBe(403);
    expect((await hide(other, 'departmentSecret1077!')).statusCode).toBe(403);
    expect((await hide(owner, 'departmentSecret1077!')).statusCode).toBe(200);
    expect((await hide(deputy, 'deputySecret1077!')).statusCode).toBe(200);
    expect((await hide(ceo, 'absentSecret1077!')).statusCode).toBe(400);
    expect((await db.select().from(taskEvents)).filter(e => e.data?.secretHidden)).toHaveLength(2);
  });

  it('suppresses a selection only in its company, including journal copies and cached tool answers', async () => {
    const { app, db, agent, ceo, companyId } = await company();
    const marker = 'companyBoundaryMarker1077!';
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false, brief: marker }).returning();
    const [owner] = await db.insert(people).values({ companyId: other!.id, name: 'Other owner', email: 'owner@other.test', status: 'active', isOwner: true, scopeKind: 'company' }).returning();
    const [sub] = await db.insert(subscriptions).values({ companyId: other!.id, provider: 'claude', kind: 'personal', status: 'ready', label: 'Other plan', ownerPersonId: owner!.id }).returning();
    const [foreign] = await db.insert(tasks).values({ companyId: other!.id, number: 1, title: 'Other task', body: marker }).returning();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Company task', brief: '', body: marker, departmentId: null, assigneeAgentId: agent.id });
    await db.update(companies).set({ brief: marker }).where(eq(companies.id, companyId));
    await db.update(tasks).set({ body: `${marker} copy` }).where(eq(tasks.id, task.id));
    await db.update(tasks).set({ body: `${marker} copy` }).where(eq(tasks.id, foreign!.id));
    const [mine, theirs] = await db.insert(jobs).values([
      { companyId, subscriptionId: agent.subscriptionId!, agentId: agent.id, kind: 'conversation', prompt: marker, timeoutMs: 1000 },
      { companyId: other!.id, subscriptionId: sub!.id, kind: 'conversation', prompt: marker, timeoutMs: 1000 },
    ]).returning();
    await db.insert(toolCalls).values([
      { id: '10770000-0000-4000-8000-000000000001', jobId: mine!.id, answer: { text: marker } },
      { id: '10770000-0000-4000-8000-000000000002', jobId: theirs!.id, answer: { text: marker } },
    ]);
    /* What a node said of each job while its row was away. */
    for (const job of [mine!, theirs!]) await db.execute(sql`insert into net.parked (job_id, node, kind, body) values (${job.id}, ${JSON.stringify({ kind: 'builtin', machine: 'm' })}::jsonb, 'event', ${JSON.stringify({ text: marker })}::jsonb)`);
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(marker);
    const parked = await db.execute(sql`select job_id, body from net.parked order by job_id = ${mine!.id}`) as { rows: { body: unknown }[] };
    expect(parked.rows.map(row => row.body)).toEqual([{ text: marker }, { text: '[hidden]' }]);
    const tables = await db.execute(sql`select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'net') order by 1`) as { rows: { name: string }[] };
    for (const { name } of tables.rows) {
      const rows = await db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`)) as { rows: { row: Record<string, unknown> }[] };
      for (const { row } of rows.rows) if (row.company_id === companyId || row.job_id === mine!.id || (name === 'public.companies' && row.id === companyId)) expect(JSON.stringify(row), name).not.toContain(marker);
    }
    expect((await db.select().from(tasks).where(eq(tasks.id, foreign!.id)))[0]!.body).toBe(`${marker} copy`);
    expect((await db.select().from(companies).where(eq(companies.id, other!.id)))[0]!.brief).toBe(marker);
    expect((await db.select().from(toolCalls).where(eq(toolCalls.jobId, theirs!.id)))[0]!.answer).toEqual({ text: marker });
    const foreignHistory = await db.execute(sql`select old from net.journal where tbl = 'tasks' and key->>'id' = ${foreign!.id} and op = 'update'`) as { rows: unknown[] };
    expect(JSON.stringify(foreignHistory.rows)).toContain(marker);
    const mineHistory = await db.execute(sql`select old from net.journal where tbl = 'tasks' and key->>'id' = ${task.id}`) as { rows: unknown[] };
    expect(JSON.stringify(mineHistory.rows)).not.toContain(marker);
  });

  it('never changes service state when the selected secret is a common word', async () => {
    const { app, db, agent, ceo, companyId } = await company();
    const [job] = await db.insert(jobs).values({ companyId, agentId: agent.id, kind: 'conversation', prompt: '', subscriptionId: agent.subscriptionId!, timeoutMs: 1000 }).returning();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: 'active conversation', departmentId: null, assigneeAgentId: agent.id });
    const hide = (value: string) => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value } });
    expect((await hide('active')).statusCode).toBe(400);
    const response = await hide('conversation');
    expect(response.statusCode, response.body).toBe(200);
    expect((await db.select().from(people)).every(person => person.status === 'active')).toBe(true);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.kind).toBe('conversation');
  });

  it('keeps the mask stable even when the selection occurs within its spelling', async () => {
    const { app, db, agent, ceo } = await company();
    const { task } = await createTask(app.ctx, { agentId: agent.id }, { title: 'Old text', brief: '', body: 'hiddenWord1', departmentId: null, assigneeAgentId: agent.id });
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: 'hiddenWord1' } });
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
    const said = async (rows: { sha256: string | null }[]) => (await Promise.all(rows.map(file => app.ctx.files.bytes(db, file.sha256!)))).map(String).join('');
    expect(await said(before)).not.toContain('archiveValue1077!');
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/hide-secret`, ...as(ceo), payload: { value: marker } });
    expect(response.statusCode, response.body).toBe(200);
    expect(await said(await db.select().from(attachments))).not.toContain(marker);
  });
});
