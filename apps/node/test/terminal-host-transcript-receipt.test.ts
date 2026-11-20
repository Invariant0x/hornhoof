import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import type { RunResult } from '../src/runner.js';
import { claudeTook } from '../src/terminal/program-restart.js';
import { LineTail } from '../src/terminal/transcripts.js';
import { claudePasted } from './fakes/word-receipts.mjs';
import { job } from './terminal-host-helpers.js';
import { cleanups as liveCleanups, liveTerminal } from './terminal-host-live-helpers.js';
import { atWork, cleanups, SESSION } from './terminal-host-receipts-helpers.js';

/* Claude Code gives up on a hook as on a status line a newer one overtook: the prompt hook that would say it took Hornhoof's
   words then says nothing, and the node took the program's own end of the turn for another turn's, so the turn stood, its
   program idle, until someone stopped it by hand. Claude's own transcript records the words it took: a new entry of the
   user with exactly those words is the receipt the lost hook would have given. A tool's output, the agent's own text, a
   person's words and an entry from before the words went in are none. */

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  for (const clean of liveCleanups.splice(0).reverse()) await clean();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const WORDS = 'Go on.';
/* Claude Code 2.1.318 to 2.1.329 mark what was typed into its input with promptSource typed. */
const userSaid = (content: unknown) => ({ type: 'user', promptSource: 'typed', message: { role: 'user', content } });

function settled(running: Promise<RunResult>) {
  let result: RunResult | undefined;
  void running.then(done => { result = done; });
  return () => result;
}

describe('an entry of Claude that shows it took these words', () => {
  it.each([
    ['the words as its text', userSaid(WORDS), true],
    ['the words with space around them', userSaid(`\n${WORDS} `), true],
    ['the words in text parts', userSaid([{ type: 'text', text: 'Go ' }, { type: 'text', text: 'on.' }]), true],
    ['a note Claude adds of its own', { ...userSaid(WORDS), isMeta: true }, false],
    ['the words said in another role', { type: 'user', message: { role: 'assistant', content: WORDS } }, false],
    ['the words beside a part of another kind', userSaid([{ type: 'text', text: WORDS }, { type: 'image', source: {} }]), false],
    ['no words at all', userSaid([]), false],
    ['an entry with no message', { type: 'user' }, false],
    ['an entry of a sub-agent with the same words', { ...userSaid(WORDS), isSidechain: true }, false],
    ['the words beside a text part that holds no string', userSaid([{ type: 'text', text: WORDS }, { type: 'text', text: 7 }]), false],
    /* What Claude writes as the user's of its own: its summary of a compacted conversation, a notice of a task of its own,
       words it queued, its note of an interruption, and an entry without a word of what was typed. */
    ["Claude's summary of the conversation it compacted", { ...userSaid(WORDS), isCompactSummary: true, isVisibleInTranscriptOnly: true }, false],
    ['a summary with no word of where it came from', { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human', message: { role: 'user', content: WORDS } }, false],
    ['a notice Claude gives itself of a task', { ...userSaid(WORDS), promptSource: 'system', turnOrigin: 'task_notification' }, false],
    ['words Claude queued and took after', { ...userSaid(WORDS), promptSource: 'queued' }, false],
    ['a note Claude adds beside a tool call', { ...userSaid(WORDS), turnCompanion: true }, false],
    ['an entry that says nothing of where it came from', { type: 'user', message: { role: 'user', content: WORDS } }, false],
    ['its note of an interruption', { type: 'user', interruptedMessageId: 'm-1', message: { role: 'user', content: WORDS } }, false],
  ])('%s', (_what, line, took) => {
    expect(claudeTook(line, WORDS)).toBe(took);
  });
});

/* Claude logs words pasted over several lines inside its paste wrapper, and tmux pastes words without their control
   characters: the receipt is the words whole as Claude got them, space folded, and nothing shorter, longer or a tool's. */
const LINES = 'From Hornhoof:\n\nGo on with #1.';

describe('an entry of Claude for words pasted over several lines', () => {
  it.each([
    ['the paste in its wrapper', userSaid(claudePasted(LINES)), true],
    ['the paste with its lines laid out otherwise', userSaid('From Hornhoof:\nGo on   with #1.'), true],
    ['only their first line', userSaid(claudePasted('From Hornhoof:')), false],
    ['one line out of them', userSaid('Go on with #1.'), false],
    ['them inside a longer paste', userSaid(claudePasted(`${LINES}\n\nAnd more.`)), false],
    ['them after other words', userSaid(`Earlier.\n\n${claudePasted(LINES)}`), false],
    ["a tool's output of them", userSaid([{ type: 'tool_result', tool_use_id: 'call-1', content: claudePasted(LINES) }]), false],
  ])('%s', (_what, line, took) => {
    expect(claudeTook(line, LINES)).toBe(took);
  });

  it('takes words with a control character as tmux pastes them, without it', () => {
    expect(claudeTook(userSaid('Go on.'), 'Go on.\x07')).toBe(true);
    expect(claudeTook(userSaid('Goon.'), 'Go\ron.')).toBe(true);
    expect(claudeTook(userSaid('Go on. And more.'), 'Go on.\x07')).toBe(false);
  });
});

/* The program came back mid-turn and Hornhoof typed the turn's words again; no hook said the program took them. */
async function retyped(words = WORDS) {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  await c.on(c.host['replayWords'](a, a.turn!, words));
  expect(a.took).toBe(false);
  return { c, a, result: settled(c.running) };
}

it("ends a turn whose words' hook was lost, once Claude's transcript shows it took those words and ended its turn", async () => {
  const { c, a, result } = await retyped();
  c.record(userSaid(WORDS));
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBeNull();
  expect(result()).toMatchObject({ ok: true, error: null });
});

it('takes the words from an entry that gives them as a text part', async () => {
  const { c, result } = await retyped();
  c.record(userSaid([{ type: 'text', text: WORDS }]));
  c.finish();
  await c.pass(1_000);
  expect(result()).toMatchObject({ ok: true, error: null });
});

it('takes words Hornhoof pasted over several lines from the paste Claude logs', async () => {
  const { c, result } = await retyped(LINES);
  c.record(userSaid(claudePasted(LINES)));
  c.finish();
  await c.pass(1_000);
  expect(result()).toMatchObject({ ok: true, error: null });
});

it.each([
  ["a tool's output with the same words", userSaid([{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: WORDS }] }])],
  ['a line the agent itself says with the same words', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WORDS }] } }],
  ["a person's other words", userSaid('Something else.')],
  ['words that only begin the same', userSaid(`${WORDS} And more.`)],
])('leaves the words waiting and the turn running on %s', async (_what, line) => {
  const { c, a, result } = await retyped();
  c.record(line);
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBe(WORDS);
  expect(a.took).toBe(false);
  expect(result()).toBeUndefined();
});

it('takes no entry from before the words went in as their receipt', async () => {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  /* The same words, said earlier in the conversation, in the log still unread as Hornhoof types them again. */
  c.record(userSaid(WORDS));
  await c.on(c.host['replayWords'](a, a.turn!, WORDS));
  const result = settled(c.running);
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBe(WORDS);
  expect(result()).toBeUndefined();
});

/* Hornhoof's words wait to go in while the program answers a person, as an operator's assignment does: what Claude takes
   meanwhile is the person's, were it the same words. The words still wait, and a later prompt of the person's, after
   their Enter, ends no turn of Hornhoof's. */
it("rules the waiting words the person's when Claude takes them before they go in, so the person's next prompt ends no turn", async () => {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  const result = settled(c.running);
  const child = Object.assign(new EventEmitter(), { stdin: { write: () => {} }, stdout: new EventEmitter(), kill: () => {} });
  vi.spyOn(c.tmux, 'attach').mockReturnValue(child as never);
  vi.spyOn(c.tmux, 'run').mockResolvedValue('');
  await c.on(c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true }));
  a.took = false;
  c.host['typingNow'](a, WORDS);
  let goIn = () => {};
  const waits = c.host['whilePromptWaits'](a, () => new Promise<void>(resolve => { goIn = resolve; }));
  c.record(userSaid(WORDS));
  c.drain();
  /* The program's answer to them ends, and Hornhoof's words go in. */
  c.finish();
  goIn();
  await c.on(waits);
  expect(a.typing).toBe(WORDS);
  /* The person presses Enter on words of their own. */
  c.host.input({ type: 'term.input', termId: 'view', data: '\r', pressedIn: 'job-receipt' });
  await c.on(c.host['hook']('receipt', 'prompt', { prompt: 'Mine.' }));
  c.finish();
  await c.pass(1_000);
  expect(a.took).toBe(false);
  expect(a.typing).toBe(WORDS);
  expect(result()).toBeUndefined();
});

/* As the program starts again, the node marks the end of its log: what follows is what the program writes from then on.
   A log it could not find then may hold the turn's words from before, and no entry of it is their receipt. */
it('takes no receipt from a log whose end was unknown as the program came back', async () => {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  const file = claudeTranscript(c.home, c.workDir, SESSION);
  c.record(userSaid(WORDS));
  renameSync(file, `${file}.away`);
  a.tail = c.host['tailFor'](a);
  renameSync(`${file}.away`, file);
  a.restarting = true;
  await c.on(c.host['replayWords'](a, a.turn!, WORDS));
  const result = settled(c.running);
  c.finish();
  await c.pass(1_000);
  expect(a.took).toBe(false);
  expect(a.typing).toBe(WORDS);
  expect(result()).toBeUndefined();
});

/* A session the program changes to while the words wait is read from its start: what it holds is no receipt of them, as
   when Claude goes on in a session of its own with the conversation so far. */
it('takes no receipt from the log of a session the program changed to while the words waited', async () => {
  const { c, a, result } = await retyped();
  const other = '0d3f4a0e-5a55-4c2e-9f61-8f0b4d1d2a11';
  const lines = [userSaid(WORDS), { type: 'system', subtype: 'turn_duration', durationMs: 1 }];
  writeFileSync(claudeTranscript(c.home, c.workDir, other), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  await c.on(c.host['hook']('receipt', 'start', { session_id: other }));
  c.drain();
  await c.pass(1_000);
  expect(a.took).toBe(false);
  expect(a.typing).toBe(WORDS);
  expect(result()).toBeUndefined();
});

/* A log followed from its end gives receipts only from what comes after an end it knew; a new session's log holds only
   what its program writes from its start. */
describe('the end of the log the receipt comes from', () => {
  it('is known for a log followed from its end only once the log was found', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-tail-')));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'log.jsonl');
    const tail = new LineTail(file, { fromEnd: true });
    expect(tail.mark()).toBeNull();
    writeFileSync(file, '{"type":"user"}\n');
    expect(tail.read()).toEqual(['{"type":"user"}']);
    expect(tail.mark()).not.toBeNull();
    expect(new LineTail(file, { fromEnd: true }).mark()).not.toBeNull();
  });

  it("is known for a new session's log before its program writes it", async () => {
    const c = await atWork('claude', 'silent');
    const a = c.host['agents'].get('receipt')!;
    a.sessionId = '6a1f0c2e-7d3b-4f5a-9e8d-1b2c3d4e5f60';
    expect(c.host['tailFor'](a, true)?.mark()).not.toBeNull();
    expect(c.host['tailFor'](a)?.mark()).toBeNull();
  });
});

/* An operator's assignment waits to go in while the program answers a person. What Claude takes meanwhile is the
   person's, were it the assignment's words: the assignment is not delivered by it, and goes in once the program is
   ready. */
it("keeps an operator's assignment to deliver when Claude takes the same words of a person's while it waits", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-operator-wait-')));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  /* The operator takes only an agent and jobs named by UUIDs. */
  const key = randomUUID();
  const c = await liveTerminal('claude', 'queued', { key, jobId: randomUUID(), watched: true, operator: { dir, connected: () => true, send: () => true } });
  c.finish();
  await c.on(c.running);
  const a = c.host['agents'].get(key)!;
  const ASSIGNMENT = 'From Hornhoof: check the checkout.';
  const idle = () => `────────────\n❯ ${c.input()}\n────────────\n  ? for shortcuts\n`;
  /* The program is ready as the turn begins, then answers the person while the assignment waits to go in: no input shows
     until it is done. */
  let answering = true;
  c.screen.mockImplementation(async () => (answering && a.promptWaits ? '✻ Answering…\n' : idle()));
  const turn = c.host.run({ ...job(key, ASSIGNMENT, { jobId: randomUUID(), workDir: a.workDir, sessionId: a.sessionId }), home: a.home, operatorDelivery: { id: randomUUID(), ordinal: 2 } });
  void turn.catch(() => {});
  /* No test here has a time limit: wait a bounded while for the assignment to wait, and say so if it never does. */
  for (let step = 0; step < 400 && !a.promptWaits; step++) await c.pass(5);
  expect(a.promptWaits).toBe(true);
  c.record(userSaid(ASSIGNMENT));
  c.host['drain'](a);
  expect(c.host['operator']!.enabled(key)).toBe(true);
  expect(c.host['operator']!.recorded(key)).toBe(false);
  expect(a.turn?.words.originalPending()).toBe(true);
  expect(a.typing).toBe(ASSIGNMENT);
  answering = false;
  await c.pass(1_000);
  expect(c.paste.mock.calls.map(([, text]) => text)).toContain(ASSIGNMENT);
});

/* The receipt boundary is the end of the log as the node read it while the words went in: a read that failed then, a
   line the program had not ended then, or a read failing after, leaves no boundary to count from. */
describe('the boundary a receipt counts from', () => {
  async function typing() {
    const c = await atWork('claude', 'silent');
    const a = c.host['agents'].get('receipt')!;
    const file = claudeTranscript(c.home, c.workDir, SESSION);
    c.drain();
    a.took = false;
    return { c, a, file, result: settled(c.running), type: () => c.host['typingNow'](a, WORDS) };
  }

  it('is none when the read as the words went in failed', async () => {
    const { c, a, file, result, type } = await typing();
    c.record(userSaid(WORDS));
    renameSync(file, `${file}.away`);
    type();
    renameSync(`${file}.away`, file);
    c.finish();
    await c.pass(1_000);
    expect(a.took).toBe(false);
    expect(result()).toBeUndefined();
  });

  it('is none while a line the program began before the words is not ended', async () => {
    const { c, a, file, result, type } = await typing();
    const line = JSON.stringify(userSaid(WORDS));
    appendFileSync(file, line.slice(0, 20));
    type();
    appendFileSync(file, `${line.slice(20)}\n`);
    c.finish();
    await c.pass(1_000);
    expect(a.took).toBe(false);
    expect(result()).toBeUndefined();
  });

  it('lapses when a read fails after the words went in', async () => {
    const { c, a, file, result, type } = await typing();
    type();
    renameSync(file, `${file}.away`);
    c.drain();
    renameSync(`${file}.away`, file);
    c.record(userSaid(WORDS));
    c.finish();
    await c.pass(1_000);
    expect(a.took).toBe(false);
    expect(result()).toBeUndefined();
  });

  it("stays at the start of a new session's log the program has not written yet", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-tail-new-')));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const tail = new LineTail(join(dir, 'new.jsonl'), { empty: true });
    expect(tail.read()).toEqual([]);
    expect(tail.mark()).not.toBeNull();
    /* A log read from its start that is not there is no known end: it may be one that went missing. */
    const other = new LineTail(join(dir, 'other.jsonl'));
    expect(other.read()).toEqual([]);
    expect(other.mark()).toBeNull();
  });
});
