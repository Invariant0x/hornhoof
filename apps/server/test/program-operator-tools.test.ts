import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { OPERATOR_PICTURE_BYTES, PROGRAM_OPERATOR_ROLE, type OperatorQuestion, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { encryptSecret } from '../src/crypto/secrets.js';
import { agentEvents, agents, attachments, jobs, machines, nodes, people, programOperatorCases, subscriptions, vaultEntries, type AgentKind } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import * as programRpc from '../src/modules/program-operator/rpc.js';
import * as turnLog from '../src/modules/tasks/turn-log.js';
import { readProgramView, reportOperatorCase, sendProgramInput } from '../src/modules/program-operator/tools.js';
import { PainterError } from '../src/modules/program-operator/painter.js';
import * as screenRenderer from '../src/modules/program-operator/screen.js';
import { registerWatchTools } from '../src/modules/tools/watch.js';
import { operatorCompany } from './program-operator-company.js';

type Caller = { id: string; companyId: string; agentId: string; agentKind: AgentKind; roleKey: string | null };
const SECRET = 'sk-live-0123456789abcdef-???';
/* Another machine's network id, whose built-in node an API key's turn can go out to. */
const MACHINE = 'b'.repeat(32);
/* Claude Code's own safety check asking before a removal on a variable that may be empty, as Neo's program showed it on 17 Nov
   at 09:30 (the picture of that operator case). Unanswered, Claude Code blocks the call by itself two minutes later. */
const RM_PERMISSION = readFileSync(new URL('./fixtures/claude-rm-permission-screen.txt', import.meta.url), 'utf8');

/* An employee of Development with its program on a node, and the orchestrator, the head of Operations and the program operator,
   each in a turn of its own. The node answers as ProgramAccess does: what the screen shows, and what came of the input. */
async function fixture() {
  const c = await operatorCompany(true);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [opsHead] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Olga', kind: 'head', roleKey: 'OPS-HEAD', departmentId: c.watcher.departmentId, subscriptionId: c.sub.id, model: '' }).returning();
  const [developer] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Dora', kind: 'worker', roleKey: 'DEV-BE', departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  const turn = async (agent: typeof agents.$inferSelect): Promise<Caller> => {
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running' }).returning();
    return { id: job!.id, companyId: c.companyId, agentId: agent.id, agentKind: agent.kind, roleKey: agent.roleKey };
  };
  const callers = { orchestrator: await turn(orchestrator!), opsHead: await turn(opsHead!), operator: await turn(c.operator!), developer: await turn(developer!), watcher: await turn(c.watcher) };
  const screen = { cells: 'Choose a theme.\n> Dark\n  Light', cols: 80, rows: 24, state: 'idle' as 'working' | 'idle', question: null as OperatorQuestion | null, tool: null as string | null, input: 'applied' as 'applied' | 'refused', answers: true };
  const snapshot = randomUUID();
  const frames = () => c.sent.mock.calls.map(([node, frame]) => ({ node, frame: frame as OperatorServerMessage })).filter((sent): sent is { node: typeof sent.node; frame: Extract<OperatorServerMessage, { type: 'program.view_get' | 'program.input_send' }> } => sent.frame.type === 'program.view_get' || sent.frame.type === 'program.input_send');
  c.sent.mockImplementation((node, frame) => {
    if (!screen.answers) return false;
    if (frame.type === 'program.view_get') queueMicrotask(() => receiveOperatorReply(c.ctx, node, { type: 'program.view', agentKey: frame.agentKey, request: frame.request, result: 'ok', reason: null, jobId: c.job.id, instance: c.fact.instance, snapshot, state: screen.state, tool: screen.tool, question: screen.question, input: 'hornhoof', undelivered: true, cols: screen.cols, rows: screen.rows, cells: screen.cells }));
    if (frame.type === 'program.input_send') queueMicrotask(() => receiveOperatorReply(c.ctx, node, { type: 'program.input_result', agentKey: frame.agentKey, action: frame.action, result: screen.input, reason: screen.input === 'refused' ? 'snapshot_stale' : null, jobId: c.job.id, instance: c.fact.instance, question: screen.question, text: frame.text?.replaceAll(SECRET, '[hidden]') ?? null, auditReason: frame.auditReason.replaceAll(SECRET, '[hidden]') }));
    return true;
  });
  const input = { employee: c.agent.id, snapshot, reason: 'The program stands on its input line.' };
  const journal = async () => (await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id))).map(e => e.data as { text: string; operatorAction?: Record<string, unknown> }).filter(d => d.operatorAction);
  return { ...c, callers, screen, snapshot, input, frames, journal };
}

/* The target on a personal plan of somebody none of the callers is. */
async function onAnotherOwnersPlan(c: Awaited<ReturnType<typeof fixture>>) {
  const [owner] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Pia', email: `pia-${randomUUID()}@example.com`, status: 'active', scopeKind: 'company' }).returning();
  const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label: 'Pia', ownerPersonId: owner!.id, status: 'ready' }).returning();
  await c.db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, c.agent.id));
  await c.db.update(jobs).set({ subscriptionId: plan!.id }).where(eq(jobs.id, c.job.id));
}

/* A turn of the employee's made after the running one that waits in its queue: on no node yet, unless one is named. */
async function queuedAfter(c: Awaited<ReturnType<typeof fixture>>, agentId: string, on: { subscriptionId?: string; nodeId?: string; builtinMachine?: string } = {}) {
  const createdAt = new Date(c.job.createdAt.getTime() + 60_000);
  await c.db.insert(jobs).values({ companyId: c.companyId, agentId, subscriptionId: on.subscriptionId ?? c.sub.id, nodeId: on.nodeId ?? null, builtinMachine: on.builtinMachine ?? null, kind: 'conversation', prompt: 'A message.', timeoutMs: 1000, status: 'queued', createdAt });
}

const tools = (c: Awaited<ReturnType<typeof fixture>>, caller: Caller) => {
  const registered = vi.fn();
  registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, caller, new Set());
  return registered.mock.calls.map(([name]) => name as string);
};

it('lets the orchestrator, the head of Operations and the program operator see the program of an employee of another department, on a plan of somebody else', async () => {
  const c = await fixture();
  await onAnotherOwnersPlan(c);
  for (const caller of [c.callers.orchestrator, c.callers.opsHead, c.callers.operator]) {
    const view = await readProgramView(c.ctx, caller, { employee: c.agent.id });
    expect(view).toMatchObject({ employee: c.agent.id, name: c.agent.name, job: c.job.id, instance: c.fact.instance, snapshot: c.snapshot, state: 'idle', input: 'hornhoof', undelivered: true, text: expect.stringContaining('Choose a theme.') });
    expect(view.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  expect(c.frames().map(({ node, frame }) => [node, frame.type, frame.agentKey])).toEqual(Array(3).fill([{ kind: 'node', nodeId: c.identity.nodeId }, 'program.view_get', c.agent.id]));
});

it('takes Ctrl+U, then words and Enter, from the orchestrator and Operations into a program on an API key, through the built-in node', async () => {
  const c = await fixture();
  const [key] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'api_key', label: 'Key', ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning();
  await c.db.update(agents).set({ subscriptionId: key!.id, nodeId: null }).where(eq(agents.id, c.agent.id));
  await c.db.update(jobs).set({ subscriptionId: key!.id, nodeId: null }).where(eq(jobs.id, c.job.id));
  for (const caller of [c.callers.orchestrator, c.callers.opsHead, c.callers.operator]) {
    await readProgramView(c.ctx, caller, { employee: c.agent.id });
    expect(await sendProgramInput(c.ctx, caller, { ...c.input, keys: ['C-u'] })).toMatchObject({ result: 'applied', reason: null });
    await readProgramView(c.ctx, caller, { employee: c.agent.id });
    expect(await sendProgramInput(c.ctx, caller, { ...c.input, text: 'Go on with the task.', keys: ['Enter'] })).toMatchObject({ result: 'applied' });
  }
  const sent = c.frames().filter(({ frame }) => frame.type === 'program.input_send');
  expect(sent.map(({ node, frame }) => frame.type === 'program.input_send' && [node, frame.keys, frame.text])).toEqual(Array(3).fill([[BUILTIN, ['C-u'], null], [BUILTIN, ['Enter'], 'Go on with the task.']]).flat());
  const journal = await c.journal();
  expect(journal).toHaveLength(6);
  expect(journal[0]!.operatorAction).toMatchObject({ actor: { id: c.callers.orchestrator.agentId }, operatorJobId: c.callers.orchestrator.id, keys: ['C-u'], key: 'C-u', text: null, result: 'applied', reason: c.input.reason });
  expect(journal[5]!.operatorAction).toMatchObject({ actor: { id: c.operator!.id, name: 'Operator' }, keys: ['Enter'], text: 'Go on with the task.', result: 'applied' });
});

it("asks the node of a busy employee's running turn for its screen, not a newer message that waits in its queue on no node", async () => {
  const c = await fixture();
  await queuedAfter(c, c.agent.id);
  expect(await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id })).toMatchObject({ employee: c.agent.id, snapshot: c.snapshot });
  expect(c.frames().map(({ node, frame }) => [node, frame.type, frame.agentKey])).toEqual([[{ kind: 'node', nodeId: c.identity.nodeId }, 'program.view_get', c.agent.id]]);
});

it("shows Claude Code's own permission question of a busy employee whose next turns wait in its queue on no node, and takes the operator's answer", async () => {
  const c = await fixture();
  /* Turns of two other tasks wait behind the running one on no node yet, as Neo's did while the question stood. */
  await queuedAfter(c, c.agent.id);
  await queuedAfter(c, c.agent.id);
  const command = 'S=/tmp/claude-1000/-data-work-agents-f7863b74-d43d-49db-9d48-774326e62283/afa1c2a5-7295-4766-9871-e26f97aca11e/scratchpad/t1152; rm -f $S/*.zip; python3 -I - "$S" <<\'EOF\'';
  const question: OperatorQuestion = { id: randomUUID(), kind: 'permission', tool: 'Bash', text: JSON.stringify({ tool: 'Bash', request: { command, description: 'Zip shots by engine without duplicates' } }), callId: 'toolu_015wakBwT26wHFL3DaVCTamK' };
  Object.assign(c.screen, { cells: RM_PERMISSION, cols: 162, rows: 47, tool: 'Bash', question });
  const view = await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id });
  expect(view).toMatchObject({ employee: c.agent.id, job: c.job.id, snapshot: c.snapshot, tool: 'Bash', question });
  expect(view.text).toContain('Dangerous rm operation on possibly-empty variable path: $S/*.zip in `rm -f $S/*.zip`');
  expect(view.text).toContain('Claude Code will automatically block this request in 1:07');
  expect(view.text).toContain('Do you want to proceed?');
  /* Only a person may approve such a removal: the operator answers No, as its rights let it. */
  expect(await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Down', 'Enter'], decision: 'denied' })).toMatchObject({ result: 'applied' });
  const node = { kind: 'node', nodeId: c.identity.nodeId };
  expect(c.frames().map(({ node, frame }) => [node, frame.type, frame.agentKey])).toEqual([[node, 'program.view_get', c.agent.id], [node, 'program.input_send', c.agent.id]]);
  const [entry] = await c.journal();
  expect(entry!.operatorAction).toMatchObject({ keys: ['Down', 'Enter'], question, requestedDecision: 'denied', decision: 'denied', result: 'applied' });
});

it('asks the node a newer turn went out to while it still waits there, on a plan and on an API key', async () => {
  const c = await fixture();
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Second' }).returning();
  const [second] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, keyHash: randomUUID(), status: 'ready', version: '0.6.1' }).returning();
  await queuedAfter(c, c.agent.id, { nodeId: second!.id });
  await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id });
  const [key] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'api_key', label: 'Key', ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning();
  const [keyed] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Kai', kind: 'worker', roleKey: 'DEV-BE', departmentId: c.dev.id, subscriptionId: key!.id, model: '' }).returning();
  await queuedAfter(c, keyed!.id, { subscriptionId: key!.id, builtinMachine: MACHINE });
  await readProgramView(c.ctx, c.callers.orchestrator, { employee: keyed!.id });
  expect(c.frames().map(({ node, frame }) => [node, frame.agentKey])).toEqual([[{ kind: 'node', nodeId: second!.id }, c.agent.id], [{ kind: 'builtin', machine: MACHINE }, keyed!.id]]);
});

it('answers no_program without asking any node for an employee whose only turn waits in its queue on no node', async () => {
  const c = await fixture();
  const [waiting] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Quinn', kind: 'worker', roleKey: 'DEV-BE', departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  await queuedAfter(c, waiting!.id);
  await expect(readProgramView(c.ctx, c.callers.orchestrator, { employee: waiting!.id })).rejects.toMatchObject({ status: 409, reason: 'programs_unavailable', message: 'The program screen is unavailable: no_program.' });
  expect(c.frames()).toEqual([]);
});

it('shows and answers a question only the subscription owner may answer', async () => {
  const c = await fixture();
  c.screen.question = { id: randomUUID(), kind: 'protected', tool: 'Permission', text: 'Only the subscription owner may respond. Sign in to continue? 1. Yes 2. No', callId: null };
  c.screen.cells = 'Only the subscription owner may respond.\nSign in to continue?\n> 1. Yes\n  2. No';
  const view = await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id });
  expect(view.question).toEqual(c.screen.question);
  expect(view.text).toContain('Only the subscription owner may respond.');
  expect(await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Down', 'Enter'], decision: 'allowed' })).toMatchObject({ result: 'applied' });
  const [entry] = await c.journal();
  expect(entry!.operatorAction).toMatchObject({ keys: ['Down', 'Enter'], question: c.screen.question, requestedDecision: 'allowed', result: 'applied' });
});

it('masks the values of secrets on the snapshot, in the question and in the log, and nothing else', async () => {
  const c = await fixture();
  await c.db.update(subscriptions).set({ secretEnc: encryptSecret(SECRET, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
  c.screen.cells = `Sign in with the code ${SECRET}\nPress Enter to go on`;
  c.screen.question = { id: randomUUID(), kind: 'protected', tool: 'Login', text: `Paste ${SECRET} here?`, callId: null };
  const view = await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id });
  expect(view.text).not.toContain(SECRET);
  expect(view.text).toContain('Press Enter to go on');
  expect(view.question!.text).toBe('Paste [hidden] here?');
  expect(await sendProgramInput(c.ctx, c.callers.orchestrator, { ...c.input, text: SECRET, keys: ['Enter'] })).toMatchObject({ result: 'applied' });
  const [entry] = await c.journal();
  expect(JSON.stringify(entry)).not.toContain(SECRET);
  expect(entry!.operatorAction).toMatchObject({ text: '[hidden]', question: { text: 'Paste [hidden] here?' } });
});

it('masks known secrets in input reasons, encoded text and every question field', async () => {
  const c = await fixture();
  await c.db.update(subscriptions).set({ secretEnc: encryptSecret(SECRET, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
  const forms = [SECRET, Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64').replace(/=+$/, ''), Buffer.from(SECRET).toString('base64url')];
  for (const value of forms) {
    c.screen.tool = value;
    c.screen.question = { id: randomUUID(), kind: 'protected', tool: value, text: `Use ${value}?`, callId: value };
    const view = await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id });
    expect(view.tool).toBe('[hidden]');
    expect(view.question).toMatchObject({ tool: '[hidden]', text: 'Use [hidden]?', callId: '[hidden]' });
    await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, text: value, keys: ['Enter'], reason: `Use ${value} to continue.` });
  }
  const entries = await c.journal();
  expect(entries).toHaveLength(forms.length);
  for (const entry of entries) {
    for (const value of forms) expect(JSON.stringify(entry)).not.toContain(value);
    expect(entry.operatorAction).toMatchObject({ reason: 'Use [hidden] to continue.', text: '[hidden]', question: { tool: '[hidden]', text: 'Use [hidden]?', callId: '[hidden]' } });
    expect(entry.text).toContain('Reason: Use [hidden] to continue.');
  }
});

it('masks only the literal form of a short known secret and keeps existing masks in operator metadata', async () => {
  const c = await fixture();
  const secret = 'hidden';
  const encoded = Buffer.from(secret).toString('base64');
  await c.db.update(subscriptions).set({ secretEnc: encryptSecret(secret, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
  c.screen.tool = secret;
  c.screen.question = { id: randomUUID(), kind: 'protected', tool: secret, text: `Use ${secret} or [hidden], encoded ${encoded}`, callId: secret };
  const view = await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id });
  expect(view).toMatchObject({ tool: '[hidden]', question: { tool: '[hidden]', text: `Use [hidden] or [hidden], encoded ${encoded}`, callId: '[hidden]' } });
});

/* An agent signs in like a person, with a sign-in of the vault typed into the program: no node knows that password. */
it('masks a vault password the operator types into a sign-in, on the screen and in the log', async () => {
  const c = await fixture();
  const password = 'vault-pass-7d1f2a9c';
  await c.db.insert(vaultEntries).values({ companyId: c.companyId, name: 'Mail', site: 'mail.example.com', login: 'ops@example.com', passwordEnc: encryptSecret(password, c.ctx.config.secret) });
  c.screen.cells = `Password: ${password}\nPress Enter to sign in`;
  const view = await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id });
  expect(view.text).toBe('Password: [hidden]\nPress Enter to sign in');
  expect(await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, text: password, keys: ['Enter'], reason: 'Sign in with the Mail entry of the vault.' })).toMatchObject({ result: 'applied' });
  const [entry] = await c.journal();
  expect(JSON.stringify(entry)).not.toContain(password);
  expect(entry!.operatorAction).toMatchObject({ text: '[hidden]' });
});

it('saves the masked actor and input intent before dispatch, then records its matching result', async () => {
  const c = await fixture();
  await c.db.update(subscriptions).set({ secretEnc: encryptSecret(SECRET, c.ctx.config.secret) }).where(eq(subscriptions.id, c.sub.id));
  const original = programRpc.requestProgramInput;
  const send = vi.spyOn(programRpc, 'requestProgramInput').mockImplementation(async (...args) => {
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
    const intents = events.map(event => event.data as { operatorInputIntent?: Record<string, unknown> }).filter(data => data.operatorInputIntent);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.operatorInputIntent).toMatchObject({ id: args[2].action, phase: 'requested', actor: { id: c.callers.operator.agentId }, operatorJobId: c.callers.operator.id, snapshot: c.snapshot, keys: ['Enter'], text: null, reason: null, textProvided: true, reasonProvided: true });
    expect(JSON.stringify(intents)).not.toContain(SECRET);
    return original(...args);
  });
  onTestFinished(() => send.mockRestore());
  const result = await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, text: SECRET, keys: ['Enter'], reason: `Use ${SECRET}.` });
  expect(result.result).toBe('applied');
  expect((await c.journal())[0]!.operatorAction).toMatchObject({ id: result.action, phase: 'finished', result: 'applied' });
});

it('sends no input when its intent cannot be saved', async () => {
  const c = await fixture();
  const log = vi.spyOn(turnLog, 'logTurnFact').mockRejectedValueOnce(new Error('Audit unavailable'));
  onTestFinished(() => log.mockRestore());
  await expect(sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Enter'] })).rejects.toThrow('Audit unavailable');
  expect(c.frames()).toEqual([]);
});

it('never journals node-only secrets, even before dispatch or without a node answer', async () => {
  const c = await fixture();
  await c.db.update(subscriptions).set({ secretEnc: null }).where(eq(subscriptions.companyId, c.companyId));
  const original = programRpc.requestProgramInput;
  const send = vi.spyOn(programRpc, 'requestProgramInput').mockImplementation(async (...args) => {
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
    expect(JSON.stringify(events)).not.toContain(SECRET);
    return original(...args);
  });
  onTestFinished(() => send.mockRestore());
  await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Enter'], text: SECRET, reason: `Use ${SECRET}.` });
  c.screen.answers = false;
  expect(await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Enter'], text: SECRET, reason: `Use ${SECRET}.` })).toMatchObject({ result: 'unknown' });
  const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
  expect(JSON.stringify(events)).not.toContain(SECRET);
});

it('keeps an employee of another department and the rest of Operations off another employee\'s program', async () => {
  const c = await fixture();
  const [misnamed] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Mimi', kind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE, departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: misnamed!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running' }).returning();
  const finished = { ...c.callers.operator };
  const refused: Caller[] = [c.callers.developer, c.callers.watcher, { id: job!.id, companyId: c.companyId, agentId: misnamed!.id, agentKind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE }, { ...c.callers.orchestrator, companyId: randomUUID() }];
  for (const caller of refused) {
    await expect(readProgramView(c.ctx, caller, { employee: c.agent.id })).rejects.toMatchObject({ status: 403 });
    await expect(sendProgramInput(c.ctx, caller, { ...c.input, keys: ['Enter'] })).rejects.toMatchObject({ status: 403 });
  }
  await expect(readProgramView(c.ctx, c.callers.operator, { employee: c.operator!.id })).rejects.toMatchObject({ status: 403 });
  await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, finished.id));
  await expect(sendProgramInput(c.ctx, finished, { ...c.input, keys: ['Enter'] })).rejects.toMatchObject({ status: 403 });
  expect(c.frames()).toEqual([]);
  expect(await c.journal()).toEqual([]);
  for (const caller of [c.callers.developer, c.callers.watcher]) expect(tools(c, caller)).not.toEqual(expect.arrayContaining(['program_screen']));
  expect(tools(c, c.callers.developer).filter(name => name.startsWith('program_'))).toEqual([]);
});

it('gives Operations the tools by role and the program operator the screen of an employee whose case it was not given', async () => {
  const c = await fixture();
  expect(tools(c, c.callers.operator)).toEqual(expect.arrayContaining(['program_screen', 'program_keys', 'program_recovery_release', 'tell_orchestrator']));
  expect(tools(c, c.callers.opsHead)).toEqual(expect.arrayContaining(['program_screen', 'program_keys', 'program_recovery_release']));
  const registered = vi.fn();
  registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, c.callers.operator, new Set());
  type Reply = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const call = (name: string, input: unknown) => (registered.mock.calls.find(([tool]) => tool === name)![2] as (input: unknown) => Promise<Reply>)(input);
  const screen = await call('program_screen', { employee: c.agent.id });
  expect(screen.isError).toBeUndefined();
  expect(screen.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining(c.snapshot) }), expect.objectContaining({ type: 'image', data: expect.any(String) })]);
  const keys = await call('program_keys', { ...c.input, keys: ['C-u'] });
  expect(keys.content[0]!.text).toContain('applied');
  const registeredDev = vi.fn();
  registerWatchTools({ registerTool: registeredDev } as unknown as McpServer, c.ctx, { ...c.callers.developer, roleKey: PROGRAM_OPERATOR_ROLE, agentKind: 'worker' }, new Set());
  const denied = await (registeredDev.mock.calls.find(([tool]) => tool === 'program_screen')![2] as (input: unknown) => Promise<Reply>)({ employee: c.agent.id });
  expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: "Only the orchestrator and Operations look at another employee's program and type into it." }] });
});

it('refuses a key that is no tmux key name before anything reaches the node', async () => {
  const c = await fixture();
  for (const keys of [['-t', 'other'], ['Enter;kill-server'], ['Ctrl+U'], []]) {
    await expect(sendProgramInput(c.ctx, c.callers.orchestrator, { ...c.input, keys })).rejects.toMatchObject({ status: 400 });
  }
  expect(c.frames()).toEqual([]);
});

it('leaves an input the node did not answer unknown and sends it once', async () => {
  const c = await fixture();
  c.screen.answers = false;
  expect(await sendProgramInput(c.ctx, c.callers.operator, { ...c.input, keys: ['Enter'] })).toMatchObject({ result: 'unknown', reason: 'action_unknown' });
  expect(c.frames()).toHaveLength(1);
  expect((await c.journal())[0]!.operatorAction).toMatchObject({ result: 'unknown', error: 'action_unknown' });
  await expect(readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id })).rejects.toMatchObject({ status: 409 });
});

it('rejects a rendered picture above the protocol limit and accepts the exact boundary', async () => {
  const c = await fixture();
  const render = vi.spyOn(screenRenderer, 'renderOperatorScreen').mockResolvedValue({ png: Buffer.alloc(OPERATOR_PICTURE_BYTES + 1), text: 'Screen', width: 80, height: 24 });
  onTestFinished(() => render.mockRestore());
  await expect(readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id })).rejects.toMatchObject({ status: 413, code: 'validation', message: 'The program picture is too large.' });
  render.mockResolvedValue({ png: Buffer.alloc(OPERATOR_PICTURE_BYTES), text: 'Screen', width: 80, height: 24 });
  expect((await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id })).png.length).toBe(OPERATOR_PICTURE_BYTES);
});

it('says the picture could not be drawn when its drawing failed, and the next look draws it', async () => {
  const c = await fixture();
  const render = vi.spyOn(screenRenderer, 'renderOperatorScreen').mockRejectedValueOnce(new PainterError('out of time'));
  onTestFinished(() => render.mockRestore());
  await expect(readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id })).rejects.toMatchObject({ status: 409, code: 'unavailable', reason: 'programs_unavailable', message: 'The program picture could not be drawn (out of time). Look again.' });
  expect((await readProgramView(c.ctx, c.callers.operator, { employee: c.agent.id })).text).toContain('Choose a theme.');
});

/* A case the program operator was given, for its report. */
async function withCase(question: boolean) {
  const c = await fixture();
  const now = new Date(); let ordinal = 0;
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  const record = (frame: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, ordinal: ordinal++, evidenceId: randomUUID() }, now);
  await record(c.fact);
  const request = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Remove ./tmp/mine?', callId: 'q' };
  if (question) await record({ type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'asked', question: request, questionOrdinal: 1, elapsedMs: 0 });
  await record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: question ? 'question_waiting' : 'assignment_unrecorded', questionId: question ? request.id : undefined, deliveryId: question ? null : c.delivery.id, evidenceKey: question ? request.id : c.delivery.id, elapsedMs: question ? 30000 : 60000, sinceLaunchMs: 60000, exit: null });
  const [incident] = await c.db.select().from(programOperatorCases);
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId }).where(eq(jobs.id, incident!.operatorJobId!));
  const caller: Caller = { id: incident!.operatorJobId!, companyId: c.companyId, agentId: c.operator!.id, agentKind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE };
  if (question) c.screen.question = request;
  const deny = async () => {
    await readProgramView(c.ctx, caller, { employee: c.agent.id });
    expect(await sendProgramInput(c.ctx, caller, { ...c.input, keys: ['Enter'], decision: 'denied', reason: 'Outside the working folder.' })).toMatchObject({ result: 'applied' });
  };
  return { ...c, caller, incident: incident!, record, request, identity, deny };
}

it('records a permission denial and sends one report with a picture to the target head after the program continues', async () => {
  const c = await withCase(true);
  await c.deny();
  await c.record({ type: 'program.question', ...c.identity, evidenceId: randomUUID(), ordinal: 0, phase: 'cleared', question: c.request, questionOrdinal: 1, elapsedMs: 30010 });
  await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  const notices = await c.turnsOf(c.head.id);
  expect(notices).toHaveLength(1);
  const [told] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, notices[0]!.id));
  expect(told!.data).toMatchObject({ notification: { source: 'program_operator' }, by: c.operator!.id, operatorQuestion: { text: c.request.text }, pictures: [{ id: expect.any(String), name: 'program-question.png' }] });
  expect((await c.journal()).map(e => e.operatorAction)).toContainEqual(expect.objectContaining({ case: c.incident.id, decision: 'denied', permissionDecision: true, key: 'Enter', question: c.request, result: 'applied', reason: 'Outside the working folder.' }));
});

it('journals an allowed permission and its exact request without sending a denial report', async () => {
  const c = await withCase(true);
  await readProgramView(c.ctx, c.caller, { employee: c.agent.id });
  expect(await sendProgramInput(c.ctx, c.caller, { ...c.input, keys: ['Enter'], reason: 'Only my temporary folder.', decision: 'allowed' })).toMatchObject({ result: 'applied' });
  expect((await c.journal()).map(e => e.operatorAction)).toContainEqual(expect.objectContaining({ decision: 'allowed', question: c.request, result: 'applied', reason: 'Only my temporary folder.' }));
  await expect(reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'No denial was made.' })).rejects.toMatchObject({ status: 403 });
});

it('reports once with the last picture when the node has become unavailable', async () => {
  const c = await withCase(false);
  const first = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'needs_owner', text: 'Owner attention needed.' });
  expect(first.pictureId).toEqual(expect.any(String));
  expect((await c.db.select().from(attachments))[0]).toMatchObject({ id: first.pictureId, operatorCaseId: c.incident.id, mediaType: 'image/png' });
  c.screen.answers = false;
  expect(await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'A replay.' })).toEqual(first);
});

it('routes a permission denial to the orchestrator when the target department head is switched off', async () => {
  const c = await withCase(true);
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.head.id));
  await c.deny();
  const result = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  expect((await c.turnsOf(orchestrator!.id)).filter(job => job.prompt.includes(result.case))).toHaveLength(1);
});

type WithCase = Awaited<ReturnType<typeof withCase>>;
const caseRow = async (c: WithCase) => (await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, c.incident.id)))[0]!;
/* Who heard of the case besides its operator: the orchestrator, the head of Operations or the target's head. */
async function toldOf(c: WithCase): Promise<string[]> {
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const turns = await Promise.all([orchestrator!.id, c.callers.opsHead.agentId, c.head.id].map(id => c.turnsOf(id)));
  return turns.flat().filter(job => job.prompt.includes(c.incident.id)).map(job => job.prompt);
}
const revoked = (c: WithCase, closedBecause: string) => expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', case: c.incident.id, disposition: 'revoke', closedBecause })]);
const atWork = (c: WithCase) => { c.screen.state = 'working'; c.screen.question = null; };

it("closes a question case by itself once a fresh screen shows the program at work asking nothing, before its operator looked, and tells no one", async () => {
  const c = await withCase(true);
  atWork(c);
  await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id });
  const closed = await caseRow(c);
  expect(closed).toMatchObject({ status: 'resolved', escalationJobId: null, recoveryHold: false, resolution: { outcome: 'question_gone', image: closed.pictureId } });
  expect(closed.pictureId).toEqual(expect.any(String));
  expect(await toldOf(c)).toEqual([]);
  revoked(c, 'question_gone');
});

it('keeps a question case open while the screen still asks it or the program stands idle', async () => {
  const c = await withCase(true);
  c.screen.state = 'working';
  await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id });
  c.screen.state = 'idle'; c.screen.question = null;
  await readProgramView(c.ctx, c.callers.orchestrator, { employee: c.agent.id });
  expect(await caseRow(c)).toMatchObject({ status: 'open', resolution: null });
});

it.each([
  ['its question cleared', (c: WithCase) => c.record({ type: 'program.question', ...c.identity, evidenceId: randomUUID(), ordinal: 0, phase: 'cleared', question: c.request, questionOrdinal: 1, elapsedMs: 30010 })],
  ['its own next event', (c: WithCase) => c.record({ ...c.fact, phase: 'activity', elapsedMs: 30010 })],
])('closes a question case as gone on %s, with no escalation', async (_, event) => {
  const c = await withCase(true);
  await event(c);
  expect(await caseRow(c)).toMatchObject({ status: 'resolved', escalationJobId: null, resolution: { outcome: 'question_gone' } });
  expect(await toldOf(c)).toEqual([]);
  revoked(c, 'question_gone');
});

it("turns a failed report on a question that went away into the case's own close: the fresh screen shows the program at work", async () => {
  const c = await withCase(true);
  atWork(c);
  const answer = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'The case shows no question.' });
  expect(answer).toMatchObject({ outcome: 'question_gone', case: c.incident.id, closed: expect.stringContaining('already closed') });
  expect(await caseRow(c)).toMatchObject({ status: 'resolved', escalationJobId: null, resolution: { outcome: 'question_gone' } });
  expect(await toldOf(c)).toEqual([]);
});

it('closes an open case on a cleared report with its fresh picture and the operator named, and tells no one', async () => {
  const c = await withCase(false);
  atWork(c);
  const result = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'cleared', text: 'The program works on its words.' });
  const closed = await caseRow(c);
  expect(result).toEqual({ outcome: 'cleared', case: c.incident.id, pictureId: closed.pictureId });
  expect(closed.pictureId).toEqual(expect.any(String));
  expect(closed).toMatchObject({ status: 'resolved', escalationJobId: null, recoveryHold: false, resolution: { outcome: 'cleared', text: 'The program works on its words.', image: closed.pictureId, actor: { id: c.operator!.id } } });
  expect(await toldOf(c)).toEqual([]);
  revoked(c, 'cleared');
});

it.each([
  ['stands idle', (c: WithCase) => { c.screen.state = 'idle'; c.screen.question = null; }, 'the program idle'],
  ['still asks', (c: WithCase) => { c.screen.state = 'working'; }, 'a question'],
  ['cannot be seen', (c: WithCase) => { c.screen.answers = false; }, 'no screen'],
])('refuses cleared while the program %s, and the case stays open', async (_, screen, shows) => {
  const c = await withCase(true);
  screen(c);
  await expect(reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'cleared', text: 'Looks fine.' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(shows) });
  expect(await caseRow(c)).toMatchObject({ status: 'open', resolution: null });
  expect(await toldOf(c)).toEqual([]);
});

it('still escalates a failed report on a screen that stands, to the orchestrator once', async () => {
  const c = await withCase(true);
  const result = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'The question stays after Enter.' });
  expect(result).toEqual({ outcome: 'failed', case: c.incident.id, pictureId: expect.any(String) });
  expect(await caseRow(c)).toMatchObject({ status: 'escalated', resolution: { outcome: 'failed', text: 'The question stays after Enter.' } });
  expect(await toldOf(c)).toHaveLength(1);
});

it('answers a late report on a case that closed by itself plainly with how it closed, from any turn of its operator, and records nothing', async () => {
  const c = await withCase(false);
  await c.record({ ...c.fact, phase: 'queued', elapsedMs: 60010 });
  const closed = await caseRow(c);
  expect(closed).toMatchObject({ status: 'resolved', resolution: { outcome: 'received' } });
  const reported = () => c.db.select().from(agentEvents).then(rows => rows.filter(row => (row.data as { operatorReport?: unknown }).operatorReport));
  const late = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'Nothing moves.' });
  expect(late).toEqual({ outcome: 'received', case: c.incident.id, pictureId: closed.pictureId, closed: `Case ${c.incident.id} is already closed (received): ${closed.resolution!.text} Your report changes nothing and goes to no one.` });
  /* Its notice was taken off the queue when the case closed; the operator reports from a turn of its own. */
  const [other] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.operator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Round.', timeoutMs: 1000, status: 'running' }).returning();
  expect(await reportOperatorCase(c.ctx, { ...c.caller, id: other!.id }, { case: c.incident.id, outcome: 'cleared', text: 'Works.' })).toEqual(late);
  expect(await reported()).toEqual([]);
  expect(await toldOf(c)).toEqual([]);
  await expect(reportOperatorCase(c.ctx, c.callers.developer, { case: c.incident.id, outcome: 'failed', text: 'Not mine.' })).rejects.toMatchObject({ status: 403 });
});
