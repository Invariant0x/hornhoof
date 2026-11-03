import { describe, expect, it } from 'vitest';
import { restartRefusal, TurnWords, type RestartEvidence } from '../src/terminal/program-restart.js';

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
