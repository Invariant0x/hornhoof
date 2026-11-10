import { describe, expect, it } from 'vitest';
import { addressed, preface } from '../src/modules/conversation/prompt.js';
import type { MessageEnvelope } from '../src/modules/events/parties.js';
import type { EventView } from '../src/modules/events/store.js';

const old = (kind: EventView['kind'], data: unknown, person: EventView['person'] = null): EventView => ({ seq: 1, kind, data, jobId: null, person, at: '2026-11-03T00:00:00.000Z' });

describe('message prompts', () => {
  it('keeps attribution and quoting when a new session catches up on legacy events', () => {
    const history = preface([
      old('message', { text: 'Keep this agreement.' }, { id: 'person', name: 'Ivan' }),
      old('message', { text: 'A department note.', from: 'agent', name: 'Hana' }),
      old('message', { text: 'A company note.', from: 'orchestrator' }),
      old('message', { text: 'Read the task.' }),
      old('text', { text: 'My answer.\nAnother line.' }),
      old('tool', { text: 'Do not put tools in conversation history.' }),
    ], 'Bruno');
    expect(history).toBe('Earlier in this conversation, in another session you cannot see:\n\nIvan:\n> Keep this agreement.\nHana:\n> A department note.\nOrchestrator:\n> A company note.\nHornhoof:\n> Read the task.\nBruno:\n> My answer.\n> Another line.');
  });

  it('keeps a people addressee and a multiline display name on one header line, once', () => {
    const message: MessageEnvelope = {
      direction: 'out',
      from: { kind: 'agent', id: 'agent', name: 'Hana\nSecond line', role: { en: 'Head', ru: 'Руководитель' }, department: null, agentKind: 'head' },
      to: { kind: 'person', id: null, name: '', role: null, department: null },
    };
    const text = addressed('Keep all\nservice instructions.', message);
    expect(text).toBe('From Hana Second line (Head) to People:\n\nKeep all\nservice instructions.');
    expect(addressed(text, message)).toBe(text);
  });
});
