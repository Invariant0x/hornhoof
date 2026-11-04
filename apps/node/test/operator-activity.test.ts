import { expect, it } from 'vitest';
import { ownThought } from '../src/terminal/operator-activity.js';

it('observes private thoughts without turning them into visible text or a word receipt', () => {
  expect(ownThought('claude', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Reason.' }] } })).toBe(true);
  expect(ownThought('kimi', { type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', turnId: 'T', part: { type: 'think', think: 'Reason.' } } }, 'T')).toBe(true);
  expect(ownThought('codex', { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T', item: { type: 'Reasoning', summary_text: ['Reason.'], raw_content: [] } } }, 'T')).toBe(true);
});

it('does not treat a foreign turn, child agent, empty thought, error, status or generic start as own activity', () => {
  expect(ownThought('claude', { type: 'assistant', isSidechain: true, message: { content: [{ type: 'thinking', thinking: 'Reason.' }] } })).toBe(false);
  expect(ownThought('claude', { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'thinking', thinking: 'Reason.' }] } })).toBe(false);
  const event = { type: 'content.part', turnId: 'old', part: { type: 'think', think: 'Reason.' } };
  expect(ownThought('kimi', { type: 'context.append_loop_event', agentId: 'child', event })).toBe(false);
  expect(ownThought('kimi', { type: 'context.append_loop_event', agentId: 'main', event }, 'new')).toBe(false);
  for (const payload of [{ type: 'task_started' }, { type: 'token_count' }, { type: 'item_completed', item: { type: 'UserMessage', content: 'Words.' } }, { type: 'item_completed', turn_id: 'old', item: { type: 'Reasoning', summary_text: ['Reason.'] } }, { type: 'item_completed', item: { type: 'Reasoning', summary_text: [''] } }]) expect(ownThought('codex', { type: 'event_msg', payload }, 'new')).toBe(false);
});

it('does not infer private thought activity for a provider without an authenticated thought record', () => {
  expect(ownThought('antigravity', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Reason.' }] } })).toBe(false);
});
