import { describe, expect, it } from 'vitest';
import { restartRefusal, type RestartEvidence } from '../src/terminal/program-restart.js';

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
