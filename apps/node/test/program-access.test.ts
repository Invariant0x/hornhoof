import { randomUUID } from 'node:crypto';
import { OPERATOR_CELLS_BYTES, OPERATOR_SNAPSHOT_MS, type OperatorQuestion } from '@hornhoof/protocol/program-operator';
import { expect, it } from 'vitest';
import { ProgramAccess, type ProgramFacts } from '../src/terminal/program-access.js';

const SECRET = 'private-token-123';

/* One agent's program on this node, as the host tells of it, with what was pasted and pressed into it. */
function fixture() {
  const agentKey = randomUUID();
  let now = 1000;
  const state = {
    facts: { jobId: randomUUID(), instance: randomUUID(), working: false, tool: null, question: null, input: 'hornhoof', undelivered: true } as ProgramFacts | null,
    cells: 'Words Hornhoof typed and nobody sent', captures: 0, typed: [] as string[], fail: false,
  };
  const access = new ProgramAccess({
    facts: async () => state.facts && { ...state.facts },
    capture: async () => { state.captures++; return { cols: 80, rows: 24, cells: state.cells }; },
    paste: async (_key, text) => { state.typed.push(`paste:${text}`); },
    press: async (_key, keys) => { state.typed.push(`keys:${keys.join(' ')}`); if (state.fail) throw new Error('tmux went away'); },
    lane: (_key, run) => run(),
    secrets: () => [SECRET],
    now: () => now,
  });
  const look = () => access.view({ type: 'program.view_get', agentKey, request: randomUUID() });
  const type = (snapshot: string, keys: string[], text: string | null = null, action = randomUUID()) => access.input({ type: 'program.input_send', agentKey, action, snapshot, keys, text });
  return { agentKey, state, access, look, type, later: (ms: number) => { now += ms; } };
}

it('shows the program as it is, with only the values of secrets masked, and what it does and holds', async () => {
  const c = fixture();
  const question: OperatorQuestion = { id: randomUUID(), kind: 'protected', tool: 'Login', text: 'Only the subscription owner may respond. Sign in?', callId: null };
  c.state.facts = { ...c.state.facts!, working: true, tool: 'Bash', question };
  c.state.cells = `Sign in with ${SECRET}\nPassword:\nAccept the terms of use?`;
  const view = await c.look();
  expect(view).toMatchObject({ result: 'ok', reason: null, jobId: c.state.facts.jobId, instance: c.state.facts.instance, snapshot: expect.any(String), state: 'working', tool: 'Bash', question, input: 'hornhoof', undelivered: true, cols: 80, rows: 24 });
  expect(view.cells).toBe('Sign in with [hidden]\nPassword:\nAccept the terms of use?');
});

it('pastes text first, then presses any keys, Ctrl+U and Escape too, into the program the look showed', async () => {
  const c = fixture();
  const view = await c.look();
  expect(await c.type(view.snapshot!, ['C-u'])).toMatchObject({ result: 'applied', reason: null, jobId: c.state.facts!.jobId, instance: c.state.facts!.instance });
  const next = await c.look();
  expect(await c.type(next.snapshot!, ['Escape', 'Enter'], 'Go on with the task.')).toMatchObject({ result: 'applied' });
  expect(c.state.typed).toEqual(['keys:C-u', 'paste:Go on with the task.', 'keys:Escape Enter']);
});

it('answers a question only the subscription owner may answer, and says which question it answered', async () => {
  const c = fixture();
  const question: OperatorQuestion = { id: randomUUID(), kind: 'protected', tool: 'Permission', text: 'Only the subscription owner may respond. 1. Allow 2. Deny', callId: 'q' };
  c.state.facts = { ...c.state.facts!, question };
  const view = await c.look();
  expect(await c.type(view.snapshot!, ['Down', 'Enter'])).toMatchObject({ result: 'applied', question });
  expect(c.state.typed).toEqual(['keys:Down Enter']);
});

it('takes one input for each look', async () => {
  const c = fixture();
  const view = await c.look();
  await c.type(view.snapshot!, ['Enter']);
  expect(await c.type(view.snapshot!, ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
  expect(await c.type(randomUUID(), ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
  expect(c.state.typed).toEqual(['keys:Enter']);
});

it('refuses a look that is 30 seconds old, or of a program that was started again since', async () => {
  const c = fixture();
  const old = await c.look();
  c.later(OPERATOR_SNAPSHOT_MS);
  expect(await c.type(old.snapshot!, ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
  const before = await c.look();
  c.state.facts = { ...c.state.facts!, instance: randomUUID() };
  expect(await c.type(before.snapshot!, ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
  expect(c.state.typed).toEqual([]);
});

it('refuses a word that is no tmux key before anything reaches the program, the text too', async () => {
  const c = fixture();
  for (const keys of [['-t'], ['Enter;kill-server'], ['Ctrl+U']]) {
    const view = await c.look();
    expect(await c.type(view.snapshot!, keys, 'words')).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
  }
  expect(c.state.typed).toEqual([]);
});

it('leaves an input it could not finish unknown, and gives the same answer for the same action without typing again', async () => {
  const c = fixture();
  c.state.fail = true;
  const view = await c.look();
  const action = randomUUID();
  const first = await c.type(view.snapshot!, ['Enter'], null, action);
  expect(first).toMatchObject({ result: 'unknown', reason: 'action_unknown' });
  expect(await c.type(view.snapshot!, ['Enter'], null, action)).toEqual(first);
  expect(c.state.typed).toEqual(['keys:Enter']);
});

it('says there is no program when none runs here, and opens or captures none', async () => {
  const c = fixture();
  c.state.facts = null;
  expect(await c.look()).toMatchObject({ result: 'refused', reason: 'no_program', snapshot: null, state: 'gone', cells: '' });
  expect(await c.type(randomUUID(), ['Enter'])).toMatchObject({ result: 'refused', reason: 'no_program', jobId: null, instance: null, question: null });
  expect(c.state.captures).toBe(0);
  expect(c.state.typed).toEqual([]);
});

it('gives no snapshot of a pane out of bounds', async () => {
  const c = fixture();
  c.state.cells = 'x'.repeat(OPERATOR_CELLS_BYTES + 1);
  expect(await c.look()).toMatchObject({ result: 'refused', reason: 'input_not_proven', snapshot: null });
});
