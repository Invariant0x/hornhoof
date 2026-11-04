import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { OPERATOR_PICTURE_BYTES, PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { agentEvents, agents, attachments, jobs, programOperatorActions, programOperatorCases, subscriptions } from '../src/db/schema.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import { readProgramScreen, sendProgramKey, reportOperatorCase } from '../src/modules/program-operator/tools.js';
import * as screenRenderer from '../src/modules/program-operator/screen.js';
import { registerWatchTools } from '../src/modules/tools/watch.js';
import { operatorCompany } from './program-operator-company.js';
import { until } from './helpers.js';

async function fixture(question = false, protectedPane = false) {
  const c = await operatorCompany(true);
  const now = new Date(); let ordinal = 0;
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  const record = (frame: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, ordinal: ordinal++, evidenceId: randomUUID() }, now);
  await record(c.fact);
  const request = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Remove ./tmp/mine?', callId: 'q' };
  if (question) await record({ type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'asked', question: request, questionOrdinal: 1, elapsedMs: 0 });
  await record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: question ? 'question_waiting' : 'assignment_unrecorded', questionId: question ? request.id : undefined, deliveryId: question ? null : c.delivery.id, evidenceKey: question ? request.id : c.delivery.id, elapsedMs: question ? 30000 : 60000, sinceLaunchMs: 60000, exit: null });
  const [incident] = await c.db.select().from(programOperatorCases);
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId }).where(eq(jobs.id, incident!.operatorJobId!));
  const caller = { id: incident!.operatorJobId!, companyId: c.companyId, agentId: c.operator!.id, agentKind: 'worker' as const, roleKey: PROGRAM_OPERATOR_ROLE };
  const input = { employee: c.agent.id, case: incident!.id };
  const snapshot = randomUUID();
  let keyResult: 'applied' | 'refused' = 'applied';
  c.sent.mockImplementation((node, frame) => {
    if (frame.type === 'program.key_prepare') queueMicrotask(() => receiveOperatorReply(c.ctx, c.identity, { type: 'program.key_prepared', ...identity, action: frame.action, result: 'ok', reason: null, lease: randomUUID() }));
    if (frame.type === 'program.screen_get') queueMicrotask(() => receiveOperatorReply(c.ctx, c.identity, { type: 'program.screen', ...identity, request: frame.request, result: 'ok', reason: protectedPane ? 'protected_screen' : null, snapshot, generation: 7, state: question ? 'awaiting_input' : 'pre_work', keysAllowed: !protectedPane, protected: protectedPane, cols: 80, rows: 24, cells: protectedPane ? 'Sign in with device code 482917' : 'Remove ./tmp/mine?\n  Yes\n  No' }));
    if (frame.type === 'program.key_send') queueMicrotask(() => receiveOperatorReply(c.ctx, c.identity, { type: 'program.key_result', ...identity, action: frame.action, result: keyResult, reason: keyResult === 'refused' ? 'program_busy' : null }));
    return true;
  });
  return { ...c, caller, input, incident: incident!, snapshot, record, request, keyResult: (value: typeof keyResult) => { keyResult = value; } };
}

it('registers tools by role rather than a removable grant', async () => {
  const c = await fixture();
  const registered = vi.fn();
  registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, c.caller, new Set());
  expect(registered.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(['program_screen', 'program_keys', 'tell_orchestrator']));
  registered.mockClear();
  registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, { ...c.caller, roleKey: 'OPS-WATCH' }, new Set());
  expect(registered.mock.calls.map(([name]) => name)).not.toContain('program_keys');
});

it('returns a bounded PNG and journals execution intent before one key, including refusal and replay', async () => {
  const c = await fixture();
  const screen = await readProgramScreen(c.ctx, c.caller, c.input);
  expect(screen).toMatchObject({ snapshot: c.snapshot, keysAllowed: true });
  expect(screen.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect((await c.db.select().from(attachments))[0]).toMatchObject({ operatorCaseId: c.incident.id, mediaType: 'image/png' });
  const command = { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue the harmless setup.', action: randomUUID() };
  const result = await sendProgramKey(c.ctx, c.caller, command);
  expect(result).toMatchObject({ result: 'applied' });
  expect(await sendProgramKey(c.ctx, c.caller, command)).toEqual(result);
  expect(c.sent.mock.calls.filter(([, frame]) => frame.type === 'program.key_send')).toHaveLength(1);
  await readProgramScreen(c.ctx, c.caller, c.input); c.keyResult('refused');
  expect(await sendProgramKey(c.ctx, c.caller, { ...command, action: randomUUID() })).toMatchObject({ result: 'refused', reason: 'program_busy' });
  const facts = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
  expect(facts.map(f => f.data)).toEqual(expect.arrayContaining([expect.objectContaining({ operatorAction: expect.objectContaining({ actor: { id: c.operator!.id, name: 'Operator' }, key: 'Enter', result: 'requested' }) }), expect.objectContaining({ operatorAction: expect.objectContaining({ result: 'refused', reason: 'Continue the harmless setup.' }) })]));
});

it('records a permission denial and sends one report with a picture to the target head after the program continues', async () => {
  const c = await fixture(true);
  await readProgramScreen(c.ctx, c.caller, c.input);
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Outside the working folder.', decision: 'denied' })).toMatchObject({ result: 'applied' });
  const asked = { type: 'program.question' as const, agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, phase: 'cleared' as const, question: c.request, questionOrdinal: 1, elapsedMs: 30010 };
  await c.record(asked);
  await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  const notices = await c.turnsOf(c.head.id);
  expect(notices).toHaveLength(1);
  const [notice] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, notices[0]!.id));
  expect(notice!.data).toMatchObject({ notification: { source: 'program_operator' }, by: c.operator!.id, operatorQuestion: { text: c.request.text } });
  expect(notice!.data).toMatchObject({ actor: { kind: 'agent', id: c.operator!.id, name: c.operator!.name, agentKind: 'worker' }, pictures: [{ id: expect.any(String), name: 'program-question.png' }] });
  const actions = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
  expect(actions.map(a => a.data)).toContainEqual(expect.objectContaining({ operatorAction: expect.objectContaining({ decision: 'denied', question: { ...c.request }, result: 'applied', reason: 'Outside the working folder.' }) }));
});

it('journals an allowed permission and its exact request without sending a denial report', async () => {
  const c = await fixture(true);
  await readProgramScreen(c.ctx, c.caller, c.input);
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Only my temporary folder.', decision: 'allowed' })).toMatchObject({ result: 'applied' });
  const facts = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
  expect(facts.map(a => a.data)).toContainEqual(expect.objectContaining({ operatorAction: expect.objectContaining({ decision: 'allowed', question: c.request, result: 'applied', reason: 'Only my temporary folder.' }) }));
  expect(await c.turnsOf(c.head.id)).toEqual([]);
});

it('rereads role, company, case, target and personal program for every call', async () => {
  const c = await fixture();
  const refused = (caller = c.caller, input = c.input) => expect(readProgramScreen(c.ctx, caller, input)).rejects.toThrow();
  await refused({ ...c.caller, companyId: randomUUID() });
  await refused(c.caller, { ...c.input, employee: c.operator!.id });
  await refused(c.caller, { ...c.input, case: randomUUID() });
  await c.db.update(agents).set({ roleKey: 'OPS-WATCH' }).where(eq(agents.id, c.operator!.id));
  await refused();
  await c.db.update(agents).set({ roleKey: PROGRAM_OPERATOR_ROLE }).where(eq(agents.id, c.operator!.id));
  await c.db.update(subscriptions).set({ kind: 'api_key' }).where(eq(subscriptions.id, c.sub.id));
  await refused();
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'program.screen_get')).toBe(false);
});

it('rejects and journals Escape and never automatically resends an uncertain action', async () => {
  const c = await fixture();
  await readProgramScreen(c.ctx, c.caller, c.input);
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Escape', reason: 'Try to cancel.' })).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'program.key_send')).toBe(false);
  const [action] = await c.db.select().from(programOperatorActions);
  expect(action).toMatchObject({ key: 'Escape', result: 'refused' });
  await c.db.update(programOperatorActions).set({ result: 'requested' }).where(eq(programOperatorActions.id, action!.id));
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Escape', reason: 'Try to cancel.', action: action!.id })).toMatchObject({ result: 'unknown' });
  expect(await c.db.select().from(programOperatorActions).where(and(eq(programOperatorActions.id, action!.id), eq(programOperatorActions.result, 'unknown')))).toHaveLength(1);
});

it.each([false, true])('refuses denial metadata on a navigation key or setup (permission: %s)', async permission => {
  const c = await fixture(permission);
  await readProgramScreen(c.ctx, c.caller, c.input);
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: permission ? 'Down' : 'Enter', reason: 'Move the selection.', decision: 'denied' })).toMatchObject({ result: 'refused' });
  await expect(reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Denied.' })).rejects.toThrow();
  expect(await c.turnsOf(c.head.id)).toEqual([]);
});

it('reads its recorded action after case closure with the original decision request', async () => {
  const c = await fixture(true);
  await readProgramScreen(c.ctx, c.caller, c.input);
  const input = { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Only temporary files.', decision: 'allowed' as const, action: randomUUID() };
  const result = await sendProgramKey(c.ctx, c.caller, input);
  await c.db.update(programOperatorCases).set({ status: 'resolved' }).where(eq(programOperatorCases.id, c.incident.id));
  expect(await sendProgramKey(c.ctx, c.caller, input)).toEqual(result);
  expect(c.sent.mock.calls.filter(([, f]) => f.type === 'program.key_send')).toHaveLength(1);
});

it('does not overwrite an uncertain terminal result with a later original completion', async () => {
  const c = await fixture();
  await readProgramScreen(c.ctx, c.caller, c.input);
  const original = c.sent.getMockImplementation()!;
  let answer: (() => void) | null = null;
  c.sent.mockImplementation((node, frame) => {
    if (frame.type !== 'program.key_send') return original(node, frame);
    answer = () => receiveOperatorReply(c.ctx, c.identity, { type: 'program.key_result', agentKey: frame.agentKey, jobId: frame.jobId, instance: frame.instance, action: frame.action, result: 'applied', reason: null });
    return true;
  });
  const input = { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue.', action: randomUUID() };
  const pending = sendProgramKey(c.ctx, c.caller, input);
  await until(() => answer !== null);
  const replay = await sendProgramKey(c.ctx, c.caller, input);
  expect(replay.result).toBe('unknown');
  answer!(); await pending;
  expect((await c.db.select().from(programOperatorActions).where(eq(programOperatorActions.id, input.action)))[0]!.result).toBe('unknown');
  expect(c.sent.mock.calls.filter(([, f]) => f.type === 'program.key_send')).toHaveLength(1);
});

it('journals authorization refusals in the authenticated caller journal without touching an unowned target', async () => {
  const c = await fixture();
  await c.db.update(agents).set({ roleKey: 'OPS-WATCH' }).where(eq(agents.id, c.operator!.id));
  await expect(sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue the theme.' })).rejects.toThrow();
  const facts = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.caller.id));
  expect(facts.map(f => f.data)).toContainEqual(expect.objectContaining({ operatorRefusal: expect.objectContaining({ actor: { id: c.operator!.id, name: c.operator!.name }, key: 'Enter', result: 'refused' }) }));
});

it('withholds protected provider cells at the server boundary as well as on the node', async () => {
  const c = await fixture(false, true);
  const screen = await readProgramScreen(c.ctx, c.caller, c.input);
  expect(screen.text).not.toContain('482917');
  expect(screen).toMatchObject({ keysAllowed: false, reason: 'protected_screen' });
});

it('sends a denial to the department head even when the orchestrator has no plan', async () => {
  const c = await fixture(true);
  await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.kind, 'orchestrator'));
  await readProgramScreen(c.ctx, c.caller, c.input);
  await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', decision: 'denied', reason: 'Outside the working folder.' });
  await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  expect(await c.turnsOf(c.head.id)).toHaveLength(1);
});

it('enforces current snapshot identity, age, key permission and a nonempty reason before sending bytes', async () => {
  const c = await fixture();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  onTestFinished(() => clock.mockRestore());
  const snapshot = { token: c.snapshot, generation: 7, at: new Date(now).toISOString(), keysAllowed: true, state: 'pre_work' as const, cols: 80, rows: 24 };
  const key = { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue.' };
  for (const [saved, input, reason] of [
    [snapshot, { ...key, snapshot: randomUUID() }, 'snapshot_stale'],
    [{ ...snapshot, at: new Date(now - 30000).toISOString() }, key, 'snapshot_stale'],
    [{ ...snapshot, keysAllowed: false }, key, 'input_not_proven'],
    [snapshot, { ...key, reason: '   ' }, 'operator_forbidden'],
  ] as const) {
    await c.db.update(programOperatorCases).set({ snapshot: saved }).where(eq(programOperatorCases.id, c.incident.id));
    expect(await sendProgramKey(c.ctx, c.caller, input)).toMatchObject({ result: 'refused', reason });
  }
  await c.db.update(programOperatorCases).set({ snapshot, readOnly: true }).where(eq(programOperatorCases.id, c.incident.id));
  expect(await sendProgramKey(c.ctx, c.caller, key)).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'program.key_prepare' || frame.type === 'program.key_send')).toBe(false);
});

it('requires an explicit permission decision on Enter and rejects action identity reuse with different intent', async () => {
  const c = await fixture(true);
  await readProgramScreen(c.ctx, c.caller, c.input);
  const action = randomUUID();
  const input = { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue.', action };
  expect(await sendProgramKey(c.ctx, c.caller, input)).toMatchObject({ result: 'refused', reason: 'input_not_proven' });
  await expect(sendProgramKey(c.ctx, c.caller, { ...input, decision: 'allowed' })).rejects.toThrow();
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'program.key_send')).toBe(false);
});

it('limits each case to twenty recorded intents even when a fresh screen permits keys', async () => {
  const c = await fixture();
  await c.db.insert(programOperatorActions).values(Array.from({ length: 20 }, () => ({ id: randomUUID(), companyId: c.companyId, caseId: c.incident.id, operatorAgentId: c.operator!.id, operatorJobId: c.caller.id, actorName: c.operator!.name, agentId: c.agent.id, jobId: c.job.id, instance: c.fact.instance, snapshot: c.snapshot, generation: 7, key: 'Enter', reason: 'Earlier intent.', digest: randomUUID(), result: 'refused' as const })));
  await readProgramScreen(c.ctx, c.caller, c.input);
  expect(await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue.' })).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'program.key_prepare')).toBe(false);
});

it('exposes screen images, key results, reports and authorization failures through the registered MCP callbacks', async () => {
  const c = await fixture();
  const registered = vi.fn();
  registerWatchTools({ registerTool: registered } as unknown as McpServer, c.ctx, c.caller, new Set());
  type Reply = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const call = (name: string, input: unknown): Promise<Reply> => {
    const callback = registered.mock.calls.find(([tool]) => tool === name)?.[2] as (input: unknown) => Promise<Reply>;
    return callback(input);
  };
  const screen = await call('program_screen', c.input);
  expect(screen.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining(c.snapshot) }), expect.objectContaining({ type: 'image', data: expect.any(String) })]);
  expect((await call('program_keys', { ...c.input, snapshot: c.snapshot, key: 'Enter', reason: 'Continue.' })).content[0]!.text).toContain('applied');
  expect((await call('tell_orchestrator', { case: c.incident.id, outcome: 'needs_owner', text: 'Owner attention needed.' })).content[0]!.text).toContain('needs_owner');
  await c.db.update(agents).set({ roleKey: 'OPS-WATCH' }).where(eq(agents.id, c.operator!.id));
  expect(await call('program_screen', c.input)).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('cannot access') }] });
});

it('reports once with the last safe picture when the node has become unavailable', async () => {
  const c = await fixture();
  const screen = await readProgramScreen(c.ctx, c.caller, c.input);
  c.sent.mockReturnValue(false);
  const result = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'The program disconnected.' });
  expect(result).toMatchObject({ outcome: 'failed', pictureId: screen.pictureId });
  expect(await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'failed', text: 'A replay.' })).toEqual(result);
});


it('rejects a rendered picture above the protocol limit before persistence and accepts the exact boundary', async () => {
  const c = await fixture();
  const render = vi.spyOn(screenRenderer, 'renderOperatorScreen').mockReturnValue({ png: Buffer.alloc(OPERATOR_PICTURE_BYTES + 1), text: 'Screen', width: 80, height: 24 });
  onTestFinished(() => render.mockRestore());
  const oversized = await readProgramScreen(c.ctx, c.caller, c.input).then(() => ({ stored: true }), (error: unknown) => ({ stored: false, error }));
  expect(oversized).toMatchObject({ stored: false, error: { status: 413, code: 'validation', message: 'The program picture is too large.' } });
  expect(await c.db.select().from(attachments)).toEqual([]);
  render.mockReturnValue({ png: Buffer.alloc(OPERATOR_PICTURE_BYTES), text: 'Screen', width: 80, height: 24 });
  const screen = await readProgramScreen(c.ctx, c.caller, c.input);
  expect(screen.png.length).toBe(OPERATOR_PICTURE_BYTES);
  expect((await c.db.select().from(attachments))[0]!.size).toBe(OPERATOR_PICTURE_BYTES);
});

it('routes a permission denial to the orchestrator when the target department head is switched off', async () => {
  const c = await fixture(true);
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.head.id));
  await readProgramScreen(c.ctx, c.caller, c.input);
  await sendProgramKey(c.ctx, c.caller, { ...c.input, snapshot: c.snapshot, key: 'Enter', decision: 'denied', reason: 'Outside the working folder.' });
  const result = await reportOperatorCase(c.ctx, c.caller, { case: c.incident.id, outcome: 'denied', text: 'Outside the working folder.' });
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  expect(await c.turnsOf(c.head.id)).toEqual([]);
  expect(await c.turnsOf(orchestrator!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ prompt: expect.stringContaining(result.case) })]));
});
