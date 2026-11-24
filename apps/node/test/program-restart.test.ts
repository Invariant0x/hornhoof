import { describe, expect, it } from 'vitest';
import { claudeWordReceipt, restartRefusal, TurnWords, type RestartEvidence } from '../src/terminal/program-restart.js';

const now = 2_000_000;
const ready: RestartEvidence = { jobId: 'job', kind: 'codex', state: 'thinking', calls: 0, question: false, signAt: 1, sessionId: 'session', restarted: false };
describe('restart permission from the program events', () => {
  it.each([
    [null, 'No turn runs for this agent.'],
    [{ ...ready, jobId: 'other' }, 'A different turn runs for this agent.'],
    [{ ...ready, calls: 1 }, 'A tool is running.'],
    [{ ...ready, question: true }, 'The program is asking a person.'],
    [{ ...ready, state: 'idle' }, 'The program is not thinking or retrying.'],
    [{ ...ready, kind: 'antigravity' }, 'This program cannot be restarted.'],
    [{ ...ready, signAt: now - 1000 }, 'The program gave a sign of life too recently.'],
    [{ ...ready, sessionId: null }, 'The session is not known.'],
    [{ ...ready, restarted: true }, 'This turn already restarted its program.'],
  ] as [RestartEvidence | null, string][])('refuses %j', (evidence, reason) => {
    expect(restartRefusal(evidence, 'job', now)).toBe(reason);
  });
  it('accepts thinking and retrying past the program limit', () => {
    expect(restartRefusal(ready, 'job', now)).toBeNull();
    expect(restartRefusal({ ...ready, state: 'retrying' }, 'job', now)).toBeNull();
    expect(restartRefusal({ ...ready, kind: 'claude' }, 'job', now)).toBe('The program gave a sign of life too recently.');
  });
});

it('resumes the exact launch flags, adding only the known session', async () => {
  const { resumeCommand } = await import('../src/terminal/program-restart.js');
  expect(resumeCommand('claude', ['claude', '--session-id', 'first', '--settings', '{}'], 'known')).toEqual(['claude', '--resume', 'known', '--settings', '{}']);
  expect(resumeCommand('codex', ['codex', '--dangerously-bypass-hook-trust', '-C', '/work', '-c', 'hooks.Stop=[]'], 'known')).toEqual(['codex', 'resume', 'known', '--dangerously-bypass-hook-trust', '-c', 'hooks.Stop=[]']);
  expect(resumeCommand('kimi', ['kimi', '--auto', '-m', 'model'], 'known')).toEqual(['kimi', '--auto', '-m', 'model', '-S', 'known']);
  expect(resumeCommand('kimi', ['kimi', '--auto', '-S', 'old'], 'known')).toEqual(['kimi', '--auto', '-S', 'known']);
  expect(resumeCommand('antigravity', ['agy', '--model', 'gemini-4-argon', '--dangerously-skip-permissions'], 'known')).toEqual([
    'agy',
    '--conversation',
    'known',
    '--model',
    'gemini-4-argon',
    '--dangerously-skip-permissions',
  ]);
  expect(resumeCommand('antigravity', ['agy', '--conversation', 'old', '--dangerously-skip-permissions'], 'known')).toEqual([
    'agy',
    '--conversation',
    'known',
    '--dangerously-skip-permissions',
  ]);
});

it.each(['codex', 'kimi', 'claude'] as const)('keeps the second pending message after %s acknowledges only the first', async kind => {
  const { TurnWords } = await import('../src/terminal/program-restart.js');
  const words = new TurnWords(['First message.', 'Second message.']);
  if (kind === 'claude') {
    words.observe(kind, { type: 'queue-operation', operation: 'enqueue', content: 'First message.' });
    words.observe(kind, { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
  } else if (kind === 'kimi') {
    words.observe(kind, { type: 'turn.steer', input: [{ type: 'text', text: 'First message.' }] });
  } else {
    words.observe(kind, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'First message.' }] } } });
  }
  expect(words.pending()).toEqual(['Second message.']);
});

describe('live word receipts', () => {
  it('lists only held receipts', () => {
    const words = new TurnWords();
    const held = words.add('Held words.', 'job');
    held.state = 'held';
    words.add('Waiting words.', 'job');
    words.add('Queued words.', 'job');
    words.queued('Queued words.', 'hook');
    words.add('Taken words.', 'job');
    words.taken('Taken words.');
    expect(words.held()).toEqual([held]);
  });

  it('waits for queued words only during the grace period after the turn ends', () => {
    const words = new TurnWords();
    words.add('Queued words.', 'job');
    words.queued('Queued words.', 'hook');
    expect(words.waitingForTurn(100)).toBe(false);
    words.end(100);
    expect(words.waitingForTurn(100)).toBe(true);
    expect(words.waitingForTurn(15_099)).toBe(true);
    expect(words.waitingForTurn(15_100)).toBe(false);
    expect(words.waitingForTurn(15_101)).toBe(false);
  });

  it('waits for held words during the grace period', () => {
    const words = new TurnWords();
    words.add('Held words.', 'job').state = 'held';
    words.end(100);
    expect(words.waitingForTurn(101)).toBe(true);
    expect(words.waitingForTurn(15_100)).toBe(false);
  });

  it('does not wait after a turn with no queued or held words', () => {
    const words = new TurnWords();
    words.end(100);
    expect(words.waitingForTurn(101)).toBe(false);
    words.add('Waiting words.', 'job');
    expect(words.waitingForTurn(101)).toBe(false);
  });

  it('lists each accepted job once and omits unbound or unaccepted words', () => {
    const words = new TurnWords();
    words.add('First words.', 'first').accepted = true;
    words.add('Unbound words.').accepted = true;
    words.add('More words.', 'first').accepted = true;
    words.add('Unaccepted words.', 'ignored');
    words.add('Last words.', 'last').accepted = true;
    expect(words.settledJobs()).toEqual(['first', 'last']);
  });

  it('settles only after the turn ends and every pending word is taken', () => {
    const words = new TurnWords(['Original prompt.']);
    words.add('Live words.', 'job');
    expect(words.settled()).toBe(false);
    words.end(100);
    expect(words.settled()).toBe(false);
    words.taken('Original prompt.');
    expect(words.settled()).toBe(false);
    words.taken('Live words.');
    expect(words.settled()).toBe(true);
  });

  it('refuses to remove missing or already taken words', () => {
    const words = new TurnWords();
    const taken = words.add('Taken words.', 'job');
    words.taken('Taken words.');
    const waiting = words.add('Waiting words.', 'job');
    expect(words.removed('Missing words.')).toBe(false);
    expect(words.removed('Taken words.')).toBe(false);
    expect(taken.state).toBe('taken');
    expect(waiting.state).toBe('waiting');
    expect(words.pending()).toEqual(['Waiting words.']);
  });

  it('marks only the oldest matching pending receipt as removed', () => {
    const words = new TurnWords();
    const taken = words.add('Same words.', 'job');
    words.taken('Same words.');
    const other = words.add('Other words.', 'job');
    const first = words.add('Same\n words.', 'job');
    const second = words.add('Same words.', 'job');
    expect(words.removed('Same words.')).toBe(true);
    expect(taken.state).toBe('taken');
    expect(other.state).toBe('waiting');
    expect(first.state).toBe('removed');
    expect(second.state).toBe('waiting');
  });

  it('returns removed words immediately with their reason', () => {
    const words = new TurnWords();
    words.add('Removed words.', 'job').accepted = true;
    words.add('Waiting words.', 'job').accepted = true;
    words.removed('Removed words.');
    expect(words.unheard(0, false, false)).toEqual([
      { text: 'Removed words.', jobId: 'job', reason: 'the program removed the queued words' },
    ]);
    expect(words.pending()).toEqual(['Waiting words.']);
    expect(words.unheard(0, false, false)).toEqual([]);
  });

  it('returns expired queued words when the caller omits idle', () => {
    const words = new TurnWords();
    words.add('Queued words.', 'job').accepted = true;
    words.queued('Queued words.', 'hook');
    words.end(100);
    expect(words.unheard(15_099)).toEqual([]);
    expect(words.unheard(15_100)).toEqual([{ text: 'Queued words.', jobId: 'job' }]);
    expect(words.unheard(15_101)).toEqual([]);
  });

  it('keeps expired queued words while the program is busy', () => {
    const words = new TurnWords();
    words.add('Queued words.', 'job').accepted = true;
    words.queued('Queued words.', 'hook');
    words.end(100);
    expect(words.unheard(15_100, false, false)).toEqual([]);
    expect(words.pending()).toEqual(['Queued words.']);
  });

  it('returns queued words when the program is gone even if it was busy', () => {
    const words = new TurnWords();
    words.add('Queued words.', 'job').accepted = true;
    words.queued('Queued words.', 'hook');
    expect(words.unheard(0, true, false)).toEqual([{ text: 'Queued words.', jobId: 'job' }]);
    expect(words.pending()).toEqual([]);
  });

  it('returns expired held words while the program is busy', () => {
    const words = new TurnWords();
    const held = words.add('Held words.', 'job');
    held.accepted = true;
    held.state = 'held';
    words.end(100);
    expect(words.unheard(15_099, false, false)).toEqual([]);
    expect(words.unheard(15_100, false, false)).toEqual([{ text: 'Held words.', jobId: 'job' }]);
  });

  it('matches flattened text oldest first, once per record, and ignores a different Codex turn', () => {
    const words = new TurnWords();
    const first = words.add('Use\n this.', 'job');
    const second = words.add('Use this.', 'job');
    const line = (turn_id: string) => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id, item: { type: 'UserMessage', content: [{ type: 'text', text: 'Use this.' }] } } });
    words.observe('codex', line('other'), 'running');
    expect(first.state).toBe('waiting');
    words.observe('codex', line('running'), 'running');
    expect(first.state).toBe('taken');
    expect(second.state).toBe('waiting');
    words.observe('codex', line('running'), 'running');
    expect(second.state).toBe('taken');
  });

  it('pairs Claude enqueue and absorption without taking the next identical entry from a second channel', () => {
    const words = new TurnWords();
    const first = words.add('Same words.', 'job');
    const second = words.add('Same words.', 'job');
    words.queued('Same words.', 'hook');
    words.observe('claude', { type: 'queue-operation', operation: 'enqueue', content: 'Same words.' });
    expect(first.state).toBe('queued');
    expect(second.state).toBe('waiting');
    words.observe('claude', { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    expect(first.state).toBe('taken');
    expect(second.state).toBe('waiting');
  });

  it('keeps exact live words across an unacknowledged restart and reports them once at the grace boundary', () => {
    const words = new TurnWords(['Original prompt.']);
    const first = words.add('From Ada:\n\nExact words.', 'job');
    first.accepted = true;
    words.replay('Continue.\n\nOriginal prompt.\n\nFrom Ada:\n\nExact words.');
    words.end(100);
    expect(words.unheard(15_099)).toEqual([]);
    expect(words.unheard(15_100)).toEqual([{ text: 'From Ada:\n\nExact words.', jobId: 'job' }]);
    expect(words.unheard(20_000)).toEqual([]);
  });

  it('acknowledges every replayed word when the restarted program takes the combined prompt', () => {
    const words = new TurnWords();
    words.add('One.', 'job').accepted = true;
    words.add('Two.', 'job').accepted = true;
    words.replay('Continue.\n\nOne.\n\nTwo.');
    words.taken('Continue. One. Two.');
    expect(words.pending()).toEqual([]);
    expect(words.unheard(0, true)).toEqual([]);
  });

  it('keeps replayed words until their text is recorded, even after the new turn starts', () => {
    const words = new TurnWords();
    words.add('Exact words.', 'job').accepted = true;
    words.replay('Continue.\n\nExact words.');
    words.clear();
    expect(words.pending()).toEqual(['Exact words.']);
    expect(words.unheard(0, true)).toEqual([{ text: 'Exact words.', jobId: 'job' }]);
  });
});

describe('Claude queue receipts', () => {
  const text = 'First line.\nSecond line.';
  const pasted = `<pasted_content id="1">\n${text}\n</pasted_content id="1">`;

  it.each([
    { where: 'enqueue', queued: pasted, removed: text },
    { where: 'removal', queued: text, removed: pasted },
  ])('matches a paste wrapper on $where while returning the queued text', ({ queued, removed }) => {
    const enqueued = ['Other words.', queued, 'Later words.'];
    expect(claudeWordReceipt({ type: 'queue-operation', operation: 'remove', content: removed }, enqueued)).toEqual({ state: 'removed', text: queued });
    expect(enqueued).toEqual(['Other words.', 'Later words.']);
  });

  it('dequeues the matching entry without removing the others', () => {
    const enqueued = ['First words.', 'Second words.', 'Third words.'];
    expect(claudeWordReceipt({ type: 'queue-operation', operation: 'dequeue', content: 'Second words.' }, enqueued)).toBeNull();
    expect(enqueued).toEqual(['First words.', 'Third words.']);
    expect(claudeWordReceipt({ type: 'queue-operation', operation: 'remove' }, enqueued)).toEqual({ state: 'removed', text: 'First words.' });
    expect(enqueued).toEqual(['Third words.']);
  });
});
