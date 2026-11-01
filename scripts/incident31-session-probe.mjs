// Isolated investigation fixture. No real provider, credentials, or listening server.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { buildApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { MIGRATIONS } from '../apps/server/src/db/client.ts';
import * as schema from '../apps/server/src/db/schema.ts';
import { hashToken } from '../apps/server/src/crypto/tokens.ts';
import { instructionsOf } from '../apps/server/src/modules/agents/instructions.ts';
import { enqueueTurn, openTypedTurn } from '../apps/server/src/modules/conversation/queue.ts';
import { said } from '../apps/server/src/modules/conversation/live.ts';
import { registerWatchTools } from '../apps/server/src/modules/tools/watch.ts';
import { handleNodeMessage } from '../apps/server/src/modules/nodes/messages.ts';
import { addNote, companyBook } from '../apps/server/src/modules/notebook/book.ts';
import { runJob } from '../apps/node/src/runner.ts';
import { codexProgram } from '../apps/node/src/terminal/programs.ts';
const { companies, people, sessions, subscriptions, agents, departments, jobs, agentEvents } = schema;
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS });
const config = loadConfig({ HORNHOOF_SECRET: Buffer.alloc(32, 7).toString('base64'), UPDATE_CHECK_MS: '0' });
const app = await buildApp({ db, config });
await app.ready();
const ctx = app.ctx;
const [company] = await db.insert(companies).values({ name: 'Session fixture' }).returning();
const [person] = await db.insert(people).values({ companyId: company.id, name: 'Fixture owner', email: 'fixture@example.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
await db.insert(sessions).values({ personId: person.id, tokenHash: hashToken('fixture-session'), expiresAt: new Date(Date.now() + 3600000) });
const [sub] = await db.insert(subscriptions).values({ companyId: company.id, ownerPersonId: person.id, provider: 'codex', kind: 'personal', label: 'Fake provider', status: 'ready', nodeVersion: '0.5.0', models: [{ id: 'gpt-6.1-sol', name: 'Fixture model', efforts: ['max'] }] }).returning();
const [dept] = await db.insert(departments).values({ companyId: company.id, templateKey: 'development', roleCode: 'DEV' }).returning();
const [orch] = await db.insert(agents).values({ companyId: company.id, kind: 'orchestrator', name: 'Fixture orchestrator', model: '', subscriptionId: sub.id }).returning();
const [head] = await db.insert(agents).values({ companyId: company.id, kind: 'head', name: 'Fixture head', roleKey: 'DEV-HEAD', departmentId: dept.id, model: '', subscriptionId: sub.id }).returning();
const steady = (await instructionsOf(ctx, orch)).hash;
await db.insert(jobs).values({ companyId: company.id, agentId: orch.id, subscriptionId: sub.id, kind: 'conversation', prompt: 'Fixture previous human request', status: 'done', sessionId: 'fixture-thread', instructionsHash: steady, timeoutMs: 1000, finishedAt: new Date(Date.now() - 1000) });
const [headJob] = await db.insert(jobs).values({ companyId: company.id, agentId: head.id, subscriptionId: sub.id, kind: 'conversation', prompt: 'Fixture head round', status: 'running', timeoutMs: 1000, startedAt: new Date() }).returning();
await db.insert(agentEvents).values([{ companyId: company.id, agentId: orch.id, kind: 'message', personId: person.id, data: { text: 'Fixture prior question' } }, { companyId: company.id, agentId: orch.id, kind: 'text', data: { text: 'Fixture prior answer' } }]);
const node = { kind: 'node', subscriptionId: sub.id };
const wire = [];
let acceptsLive = true;
ctx.hub.isReady = () => true;
ctx.hub.hasTerminals = () => true;
ctx.hub.send = (identity, message) => {
  wire.push(message);
  if (message.type === 'agent.say') queueMicrotask(() => said(ctx, identity, message.ref, acceptsLive));
  return true;
};
const tools = new Map();
registerWatchTools({ registerTool(name, _spec, handler) { tools.set(name, handler); } }, ctx, { id: headJob.id, companyId: company.id, agentId: head.id, agentKind: 'head' }, new Set());
const report = text => tools.get('tell_orchestrator')({ text });
const runs = () => wire.filter(m => m.type === 'job.run');
const prefix = 'Earlier in this conversation, in another session you cannot see:';
const finish = async (run, sessionId = 'fixture-thread') => handleNodeMessage(ctx, node, { type: 'job.done', jobId: run.jobId, ok: true, sessionId, result: 'Fixture reply', tail: '', error: null });
const human = text => enqueueTurn(ctx, { companyId: company.id, agentId: orch.id, prompt: text, createdBy: person.id, message: { personId: person.id, text } });
try {
  await report('Fixture idle report');
  assert.equal(runs().length, 1);
  assert.equal(runs()[0].sessionId, 'fixture-thread');
  assert.ok(!runs()[0].prompt.startsWith(prefix));
  await finish(runs().at(-1));
  console.log('PASS idle: staff report creates a job and resumes the prior thread');

  const active = await human('Fixture active human request');
  const before = runs().length;
  await report('Fixture active report');
  assert.equal(runs().length, before);
  assert.ok(wire.some(m => m.type === 'agent.say' && m.text.includes('Fixture active report')));
  const messages = await db.select().from(agentEvents).where(eq(agentEvents.jobId, active));
  assert.ok(messages.some(e => e.data.from === 'agent'));
  assert.ok(messages.some(e => e.kind === 'message' && e.data.text === 'Fixture active human request'));
  assert.equal(runs().at(-1).prompt, 'Fixture active human request');
  await finish(runs().at(-1));
  console.log('PASS active: accepted staff message stays in the human job');

  acceptsLive = false;
  await human('Fixture queue active');
  await human('Fixture queued human');
  await report('Fixture queued report');
  const activeRun = runs().at(-1);
  await finish(activeRun);
  assert.equal(runs().at(-1).prompt, 'Fixture queued human');
  await finish(runs().at(-1));
  assert.ok(runs().at(-1).prompt.endsWith('Fixture queued report'));
  assert.equal(runs().at(-1).sessionId, 'fixture-thread');
  await finish(runs().at(-1));
  acceptsLive = true;
  console.log('PASS queued: declined live delivery preserves queued human before staff');

  const instructionsBefore = await instructionsOf(ctx, orch);
  await addNote(ctx, companyBook(company.id), 'Fixture notebook addition', { personId: person.id, byOrchestrator: false });
  const instructionsAfter = await instructionsOf(ctx, orch);
  assert.notEqual(instructionsAfter.text, instructionsBefore.text);
  assert.equal(instructionsAfter.hash, instructionsBefore.hash);
  await report('Fixture notebook report');
  assert.equal(runs().at(-1).sessionId, 'fixture-thread');
  assert.ok(!runs().at(-1).prompt.startsWith(prefix));
  await finish(runs().at(-1));
  const spec = codexProgram.launch({ bin: 'fake-codex', home: '/fixture/home', workDir: '/fixture/work', sessionId: 'fixture-thread', model: 'gpt-6.1-sol', effort: 'max', urls: { mcpUrl: 'http://fixture.invalid/mcp', hookUrl: 'http://fixture.invalid/hook', attachUrl: 'http://fixture.invalid/attach' } });
  assert.equal(spec.command[1], 'resume');
  assert.equal(spec.command[2], 'fixture-thread');
  console.log('PASS notebook: text changes, server hash stays; supplied session plans resume');

  const changed = await app.inject({ method: 'PATCH', url: `/api/agents/${orch.id}`, cookies: { hh_session: 'fixture-session' }, payload: { model: 'gpt-6.1-sol', effort: 'max' } });
  assert.equal(changed.statusCode, 200, changed.body);
  const typed = await openTypedTurn(ctx, node, orch.id, 'Fixture typed human after card change', person.id);
  assert.ok(typed);
  const [typedJob] = await db.select().from(jobs).where(eq(jobs.id, typed.jobId));
  assert.equal(typedJob.instructionsHash, steady);
  await finish({ jobId: typed.jobId });
  await report('Fixture first automatic report after model selection');
  const fresh = runs().at(-1);
  assert.equal(fresh.sessionId, null);
  assert.ok(fresh.prompt.startsWith(prefix));
  assert.ok(fresh.prompt.endsWith('Fixture first automatic report after model selection'));
  await finish(fresh, 'fixture-new-thread');
  console.log('PASS typed hash: old inherited hash plus newly selected model makes automatic fresh bootstrap');

  await enqueueTurn(ctx, { companyId: company.id, agentId: orch.id, prompt: '', createdBy: null });
  await finish(runs().at(-1), null);
  await report('Fixture after null-session completion');
  assert.equal(runs().at(-1).sessionId, null);
  assert.ok(runs().at(-1).prompt.startsWith(prefix));
  await finish(runs().at(-1), 'fixture-after-null');
  console.log('PASS latest null: a completed job without session masks older resumable job');

  const data = mkdtempSync(join(tmpdir(), 'hh-incident31-node-'));
  const received = [];
  const adapter = { secrets: async () => [], run: async input => { received.push(input); return { ok: true, sessionId: input.sessionId ?? 'fixture-local-thread', result: 'Fixture result', output: '', error: null, limits: null }; } };
  const message = { type: 'job.run', jobId: 'fixture-job-1', subscriptionId: 'fixture-sub', provider: 'codex', prompt: 'Fixture node resume', sessionId: 'missing-registry-thread', model: null, secret: null, instructions: null, toolToken: null, timeoutMs: 1000, workspace: { key: 'fixture-agent', repo: null } };
  const outcome = await runJob(adapter, message, data);
  assert.equal(received[0].sessionId, null);
  await runJob(adapter, { ...message, jobId: 'fixture-job-2', sessionId: outcome.sessionId }, data);
  assert.equal(received[1].sessionId, 'fixture-local-thread');
  rmSync(data, { recursive: true });
  console.log('PASS node registry: unknown supplied session drops; remembered local session resumes');

  const sqlAgentId = '7f038470-9455-432f-a113-0d7f72bd87cd';
  await db.insert(agents).values({ id: sqlAgentId, companyId: company.id, kind: 'orchestrator', name: 'SQL fixture only', model: '', subscriptionId: sub.id });
  const sqlRows = [
    { prompt: 'Fixture predecessor', createdAt: '2026-11-01T00:16:00Z', finishedAt: '2026-11-01T00:16:59Z' },
    { prompt: 'Fixture created before window', createdAt: '2026-10-31T23:59:00Z', finishedAt: '2026-11-01T00:17:00Z' },
    { prompt: '', createdAt: '2026-11-01T00:28:52Z', finishedAt: '2026-11-01T00:28:52.001Z', sessionId: null },
    { prompt: `${prefix}\nFixture history and report`, createdAt: '2026-11-01T00:28:53Z', finishedAt: '2026-11-01T00:30:03Z' },
    { prompt: 'Fixture outside window', createdAt: '2026-11-01T00:30:03.001Z', finishedAt: '2026-11-01T00:30:04Z' },
    { prompt: 'Fixture started only in window', createdAt: '2026-10-31T23:59:00Z', startedAt: '2026-11-01T00:17:00Z', finishedAt: '2026-11-01T00:31:00Z' },
    { prompt: 'Fixture test kind', kind: 'test', createdAt: '2026-11-01T00:30:03Z', finishedAt: '2026-11-01T00:30:04Z' },
  ];
  await db.insert(jobs).values(sqlRows.map(row => ({ companyId: company.id, agentId: sqlAgentId, subscriptionId: sub.id, kind: row.kind ?? 'conversation', prompt: row.prompt, status: 'done', timeoutMs: 1000, sessionId: row.sessionId === null ? null : 'fixture-sql-thread', instructionsHash: steady, createdAt: new Date(row.createdAt), startedAt: row.startedAt ? new Date(row.startedAt) : null, finishedAt: new Date(row.finishedAt) })));
  const sqlResults = await client.exec(readFileSync(new URL('./incident31-jobs.sql', import.meta.url), 'utf8'));
  const metadata = sqlResults.find(result => result.fields.some(field => field.name === 'jobs_metadata')).rows[0].jobs_metadata;
  assert.equal(metadata.length, 6);
  assert.equal(metadata.filter(row => row.predecessor_before_window).length, 1);
  assert.equal(metadata.filter(row => row.empty_start).length, 1);
  assert.equal(metadata.filter(row => row.recovery_prefix).length, 1);
  assert.equal(metadata.filter(row => row.kind === 'test').length, 1);
  assert.ok(metadata.every(row => !('prompt' in row) && !('tool_token_hash' in row)));
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  console.log('PASS SQL: six rows, both inclusive bounds, earlier creation/later finish, predecessor, empty start, all kinds; no prompts/tokens; rolled back');
  console.log('COMPLETE 7 isolated scenarios and SQL metadata check; no incident root cause asserted');
} finally {
  await app.close();
  await client.close();
}
