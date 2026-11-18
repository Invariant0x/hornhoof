import { expect, it } from 'vitest';
import { operatorQuestion } from '../src/terminal/operator-question.js';

it.each(['AskUserQuestion', 'ExitPlanMode'])('keeps %s work decisions outside operator permission input', tool_name => {
  expect(operatorQuestion({ tool_name, tool_input: { question: 'Approve this approach?' } }, [])).toMatchObject({ kind: 'work' });
});

it('keeps a sign-in question as the program asks it, of its own kind, for the orchestrator and Operations to answer', () => {
  const question = operatorQuestion({ tool_name: 'Login', tool_input: { device_code: 'fresh-482917' } }, []);
  expect(question.kind).toBe('protected');
  expect(question.text).toBe('{"tool":"Login","request":{"device_code":"fresh-482917"}}');
});

it('masks known credentials in every question field before clipping and keeps a repeated event identity', () => {
  const secret = 'private-secret-123';
  const data = { tool_name: 'Bash', tool_use_id: `call-${secret}`, tool_input: { command: `read ./tmp/mine ${secret}` } };
  const question = operatorQuestion(data, [secret]);
  expect(JSON.stringify(question)).not.toContain(secret);
  expect(operatorQuestion(data, [secret], question)).toEqual(question);
});

it('masks a short known credential in a question and keeps the tool as a work decision', () => {
  const secret = 'Ask';
  const question = operatorQuestion({ tool_name: 'AskUserQuestion', tool_use_id: 'call-Ask', tool_input: 'Use Ask' }, [secret]);
  expect(question).toMatchObject({ kind: 'work', tool: '[hidden]UserQuestion', callId: 'call-[hidden]', text: '{"tool":"[hidden]UserQuestion","request":"Use [hidden]"}' });
});

it('uses provider call-id and request fallbacks without exposing unbounded identifiers', () => {
  expect(operatorQuestion({ tool_call_id: 42, input: 'Continue?' }, [])).toMatchObject({ tool: 'Permission', callId: '42', kind: 'permission', text: '{"tool":"Permission","request":"Continue?"}' });
  expect(operatorQuestion({ tool_use_id: {}, message: 'Ready?' }, [])).toMatchObject({ callId: null, text: '{"tool":"Permission","request":"Ready?"}' });
  expect(operatorQuestion({}, [])).toMatchObject({ callId: null, text: '{"tool":"Permission","request":null}' });
  expect(operatorQuestion({ tool_use_id: 'a'.repeat(150), tool_input: 'x'.repeat(5000) }, []).callId).toHaveLength(128);
});
