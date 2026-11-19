import { randomUUID } from 'node:crypto';
import type { NodeMessage } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, attachments, computerRuns, jobs, taskEvents, toolCalls, vaultEntries, vaultLog } from '../src/db/schema.js';
import { INVOCATION } from '../src/modules/tools/calls.js';
import { appendTurnEvent } from '../src/modules/events/store.js';
import { failOpenJobs, handleNodeMessage } from '../src/modules/nodes/messages.js';
import { ownMachine } from '../src/modules/nodes/hub.js';
import { forgetPrivateTurn, privateTurn } from '../src/modules/tools/private-turns.js';
import { cancelJob } from '../src/modules/tasks/wake.js';
import { as, mcp } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

const PASSWORD = 'zqx';
/* The RFC 6238 seed of SHA1: at 1111111109 s its six-digit code is 081804, one second before the next period. */
const CODE = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const AT = 1111111109_000;

vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] }));

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const answer = (reply: ToolReply) => JSON.parse(reply.content[0]!.text) as Record<string, unknown>;

async function setUp() {
  const c = await vaultCompany();
  c.app.ctx.clock = () => AT;
  await c.add(c.ceoSession, { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: CODE });
  await c.add(c.samSession, { name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-crm-1234' });
  return c;
}

const call = async (c: Awaited<ReturnType<typeof setUp>>, token: string, name: string, args: Record<string, unknown> = {}) =>
  (await (await mcp(c.app, token)).callTool({ name, arguments: args })) as ToolReply;

/* The keeper's retry id is trusted here, as in tool-calls.test.ts. */
async function replay(c: Awaited<ReturnType<typeof setUp>>, token: string, name: string, args: Record<string, unknown>, id: string) {
  c.config.tunnelHost = 'localhost';
  const res = await c.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, [INVOCATION]: id, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(res.statusCode).toBe(200);
  return res.json().result as ToolReply;
}

describe('the vault for agents', () => {
  it('keeps secret creation on the protected vault screen', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    const catalog = await (await mcp(c.app, token)).listTools();
    expect(catalog.tools.map(tool => tool.name)).not.toContain('vault_save');
    expect(catalog.tools.find(tool => tool.name === 'vault_entry')?.description).toContain('protected sign-in field');
  });
  it('keeps no secret answer in replay storage or the journal', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    expect(answer(await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID()))).toMatchObject({ password: PASSWORD, code: '081804' });
    expect(await c.db.select().from(toolCalls)).toEqual([]);
    const journal = await c.db.execute(sql`select * from net.journal`);
    for (const secret of [PASSWORD, CODE, '081804']) expect(JSON.stringify(journal)).not.toContain(secret);
  });

  it('checks the entry again when the same invocation is repeated after deletion', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    const id = randomUUID();
    expect(answer(await replay(c, token, 'vault_entry', { entry: 'Partner site' }, id))).toMatchObject({ password: PASSWORD });
    const [entry] = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Partner site'));
    expect((await c.app.inject({ method: 'DELETE', url: `/api/vault/${entry!.id}`, ...as(c.ceoSession) })).statusCode).toBe(204);
    const again = await replay(c, token, 'vault_entry', { entry: 'Partner site' }, id);
    expect(again.isError).toBe(true);
    expect(answer(again)).toMatchObject({ error: { reason: 'vault_unknown' } });
    expect(JSON.stringify(again)).not.toContain(PASSWORD);
  });

  it('keeps the orchestrator shelf outside replay for a sensitive target', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.orchestrator.id);
    const id = randomUUID();
    const args = { name: 'vault_entry', arguments: { entry: 'Partner site' } };
    expect(answer(await replay(c, token, 'use_tool', args, id))).toMatchObject({ password: PASSWORD });
    expect(await c.db.select().from(toolCalls)).toEqual([]);
    const [entry] = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Partner site'));
    await c.app.inject({ method: 'DELETE', url: `/api/vault/${entry!.id}`, ...as(c.ceoSession) });
    const again = await replay(c, token, 'use_tool', args, id);
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again)).not.toContain(PASSWORD);
  });

  it.each([false, true])('does not retain a secret tool input or result reported by a node, delegated: %s', async delegated => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id);
    const input = { password: PASSWORD, code: CODE };
    await appendTurnEvent(c.app.ctx, job.id, { kind: 'tool', name: delegated ? 'hornhoof.use_tool' : 'hornhoof.vault_save', input: JSON.stringify(delegated ? { name: 'vault_save', arguments: input } : input) }, eq(jobs.id, job.id));
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    await appendTurnEvent(c.app.ctx, job.id, { kind: 'tool_result', ok: true, summary: JSON.stringify({ password: PASSWORD, code: '081804' }) }, eq(jobs.id, job.id));
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id));
    for (const secret of [PASSWORD, CODE, '081804']) expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('keeps entry and completion details readable when the node never reported the sensitive call', async () => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    const text = `Read Partner site at https://partner.example/login as team@acme.test with ${PASSWORD} and 081804.`;
    const masked = 'Read Partner site at https://partner.example/login as team@acme.test with [hidden] and [hidden].';
    await handleNodeMessage(c.app.ctx, { kind: 'builtin', machine: ownMachine(c.config) }, { type: 'job.done', jobId: job.id, ok: false, sessionId: null, result: '', tail: text, error: 'agent_failed', failure: { kind: 'unknown', text, retryable: false } });
    const [done] = await c.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(done).toMatchObject({ status: 'failed', tail: masked, failure: { text: masked } });
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id));
    expect(events).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ kind: 'tool', name: 'vault_entry', input: '{"entry":"Partner site"}' }) }));
    const result = events.find(row => row.kind === 'tool_result')?.data as { summary: string };
    expect(JSON.parse(result.summary)).toMatchObject({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: '[hidden]', code: '[hidden]' });
    expect(JSON.stringify([done, events])).not.toContain(PASSWORD);
    expect(JSON.stringify([done, events])).not.toContain('081804');
  });

  it('refuses an old vault_save call without recording or echoing its values', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id);
    const refused = await replay(c, token, 'vault_save', { name: 'New sign-in', site: 'https://example.com', login: 'team', password: PASSWORD, code: CODE }, randomUUID());
    expect(refused.isError).toBe(true);
    expect(await c.db.select().from(toolCalls)).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    expect(JSON.stringify(refused)).not.toContain(CODE);
    expect(await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'New sign-in'))).toEqual([]);
  });

  it('delivers reports with exact secrets hidden while keeping ordinary words and safe reports', async () => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id, c.task.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    for (const text of [`Signed in with ${PASSWORD}; code 081804.`, 'The site is ready.']) {
      const comment = await replay(c, token, 'comment', { task: c.task.number, text }, randomUUID());
      expect(comment.isError).toBeUndefined();
      await appendTurnEvent(c.app.ctx, job.id, { kind: 'text', text }, eq(jobs.id, job.id));
    }
    const log = JSON.stringify(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id)));
    expect(log).toContain('Signed in with [hidden]; code [hidden].');
    expect(log).toContain('The site is ready.');
    expect(log).not.toContain(PASSWORD);
    const events = JSON.stringify(await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id)));
    expect(events).toContain('Signed in with [hidden]; code [hidden].');
    expect(events).toContain('The site is ready.');
    expect(events).not.toContain(PASSWORD);
  });

  it('rejects a computer command containing a secret before recording or sending it', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.orchestrator.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    const reply = await replay(c, token, 'computer', { command: `echo ${PASSWORD}` }, randomUUID());
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toContain('your own program');
    expect(await c.db.select().from(computerRuns)).toEqual([]);
    expect(JSON.stringify(await c.db.select().from(agentEvents))).not.toContain(PASSWORD);
    expect(JSON.stringify(await c.db.select().from(toolCalls))).not.toContain(PASSWORD);
  });

  it('refuses a transcript attachment containing a value issued in this turn', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id, c.task.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    const uploaded = await c.app.inject({ method: 'POST', url: `/api/attachments?task=${c.task.number}&name=transcript.txt`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from(`Signed in with ${PASSWORD}`) });
    expect(uploaded.statusCode).toBe(400);
    expect(uploaded.json().error.reason).toBe('attachment_invalid');
    expect(await c.db.select().from(attachments)).toEqual([]);
    expect(uploaded.body).not.toContain(PASSWORD);
  });

  it('refuses a generic API write after a restart loses the vault masks', async () => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.orchestrator.id);
    expect(answer(await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID()))).toMatchObject({ password: PASSWORD });
    expect(privateTurn(c.db, job.id)?.values.text(PASSWORD)).toBe('[hidden]');
    forgetPrivateTurn(c.db, job.id);

    const refused = await replay(c, token, 'api', {
      method: 'PATCH', path: `/api/agents/${c.nora.id}`, body: { name: `Name with ${PASSWORD}` },
    }, randomUUID());
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('End this turn and start a new one');
    const [row] = await c.db.select({ name: agents.name }).from(agents).where(eq(agents.id, c.nora.id));
    expect(row?.name).toBe(c.nora.name);
    expect((await replay(c, token, 'company', {}, randomUUID())).isError).toBeUndefined();
  });

  it.each([false, true])('keeps node-masked output readable after a server restart; failed: %s', async failed => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id, c.task.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    forgetPrivateTurn(c.db, job.id);
    const text = 'Report from Partner site with [hidden] and [hidden].';
    await appendTurnEvent(c.app.ctx, job.id, { kind: 'text', text }, eq(jobs.id, job.id));
    const entry = { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: '081804' };
    await appendTurnEvent(c.app.ctx, job.id, { kind: 'tool_result', ok: true, summary: JSON.stringify(entry) }, eq(jobs.id, job.id));
    const refused = await replay(c, token, 'comment', { task: c.task.number, text: `Report with ${PASSWORD}` }, randomUUID());
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('End this turn and start a new one');
    expect(JSON.stringify(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id)))).not.toContain('Report with');
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id));
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain('081804');
    expect(events.filter(row => row.kind === 'tool_result').map(row => JSON.parse((row.data as { summary: string }).summary))).toEqual([
      expect.objectContaining({ ...entry, password: '[hidden]', code: '[hidden]' }),
      { ...entry, password: '[hidden]', code: '[hidden]' },
    ]);
    expect(JSON.stringify(await c.db.select().from(toolCalls))).not.toContain(PASSWORD);
    expect(JSON.stringify(await c.db.select().from(agentEvents))).toContain(text);
    const completion: Extract<NodeMessage, { type: 'job.done' }> = { type: 'job.done', jobId: job.id, ok: !failed, sessionId: null, result: text, tail: text, error: failed ? 'agent_failed' : null,
      failure: failed ? { kind: 'unknown', text, retryable: false } : undefined };
    await handleNodeMessage(c.app.ctx, { kind: 'builtin', machine: ownMachine(c.config) }, completion);
    const [ended] = await c.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(JSON.stringify(ended)).not.toContain(PASSWORD);
    expect(ended!.tail).toBe(text);
    if (failed) expect(ended!.failure?.text).toBe(text);
    else expect(ended!.result).toBe(text);
  });

  it.each(['cancelled', 'node lost'])('drops temporary values when a turn ends as %s without a node receipt', async ending => {
    const c = await setUp();
    const { token, job } = await c.startTurn(c.nora.id);
    await replay(c, token, 'vault_entry', { entry: 'Partner site' }, randomUUID());
    expect(privateTurn(c.db, job.id)?.values.text(PASSWORD)).toBe('[hidden]');
    if (ending === 'cancelled') await cancelJob(c.app.ctx, job.id);
    else expect(await failOpenJobs(c.app.ctx, eq(jobs.id, job.id), 'machine_offline')).toContain(job.id);
    expect(privateTurn(c.db, job.id)).toBeUndefined();
  });

  it('lists every entry of the company to each of its agents, with no password', async () => {
    const c = await setUp();
    for (const agent of [c.nora, c.aide, c.orchestrator]) {
      const { token } = await c.startTurn(agent.id);
      const list = await call(c, token, 'vault_entries');
      expect(answer(list).entries, agent.name).toEqual([
        { name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', hasCode: false },
        { name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', hasCode: true },
      ]);
      expect(JSON.stringify(list)).not.toContain(PASSWORD);
    }
  });

  it('gives the agent that asks the login, the password and the code of this moment as text, and never the code secret', async () => {
    const c = await setUp();
    for (const agent of [c.nora, c.aide]) {
      const { token } = await c.startTurn(agent.id);
      const reply = await call(c, token, 'vault_entry', { entry: 'partner SITE' });
      expect(reply.isError, agent.name).toBeUndefined();
      expect(answer(reply)).toEqual({ name: 'Partner site', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: '081804', codeSecondsLeft: 1 });
      expect(JSON.stringify(reply)).not.toContain(CODE);
    }
    const { token } = await c.startTurn(c.nora.id);
    expect(answer(await call(c, token, 'vault_entry', { entry: 'CRM' }))).toEqual({ name: 'CRM', site: 'https://crm.example', login: 'sales@acme.test', password: 'pw-crm-1234' });
  });

  it('logs who took which entry for which task, with no value', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.nora.id, c.task.id);
    await call(c, token, 'vault_entry', { entry: 'Partner site' });
    const taken = await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'));
    expect(taken).toMatchObject([{ entryName: 'Partner site', site: 'https://partner.example/login', agentId: c.nora.id, personId: null, taskId: c.task.id }]);
    expect(JSON.stringify(taken)).not.toContain(PASSWORD);
    expect(JSON.stringify(taken)).not.toContain('081804');
    const [entry] = await c.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Partner site'));
    const log = await c.app.inject({ url: `/api/vault/${entry!.id}/log`, ...as(c.samSession) });
    expect(log.json().log[0]).toMatchObject({ kind: 'taken', agent: { name: 'Nora' }, person: null, task: { id: c.task.id, number: c.task.number } });
    expect(log.body).not.toContain(PASSWORD);
  });

  it('knows no entry of another company and none that is not saved', async () => {
    const c = await setUp();
    const { token } = await c.startTurn(c.otto.id);
    expect(answer(await call(c, token, 'vault_entries')).entries).toEqual([]);
    const theirs = await call(c, token, 'vault_entry', { entry: 'Partner site' });
    expect(theirs.isError).toBe(true);
    expect(answer(theirs)).toMatchObject({ error: { reason: 'vault_unknown' } });
    expect(JSON.stringify(theirs)).not.toContain(PASSWORD);
    expect(await c.db.select().from(vaultLog).where(eq(vaultLog.kind, 'taken'))).toEqual([]);
  });

});
