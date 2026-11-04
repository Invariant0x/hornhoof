import { NOTIFICATION_NAMES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { messageHeading } from '../src/modules/conversation/prompt.js';
import { MessageEnvelopeSchema, type MessageEnvelope } from '../src/modules/events/parties.js';

const from = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null } as const;
const to = { kind: 'agent', id: 'a1', name: 'Bruno', role: null, department: null } as const;
const actor = { ...to, id: 'a2', name: 'Hana' };

describe('notification headings', () => {
  it.each(Object.entries(NOTIFICATION_NAMES))('names source %s and its task', (source, name) => {
    expect(name.trim()).not.toBe('');
    const message = MessageEnvelopeSchema.parse({ direction: 'in', from, to, notification: { source, tasks: [{ id: 't1', number: 226 }] } });
    expect(messageHeading(message)).toBe(`From Hornhoof, ${name} on #226 to Bruno:`);
  });
  it('names the source, cause and recipient', () => {
    const message = MessageEnvelopeSchema.parse({ direction: 'in', from, to, notification: { source: 'go_on', tasks: [{ id: 't1', number: 223 }] } });
    expect(messageHeading(message)).toBe('From Hornhoof, turn ended before the work on #223 to Bruno:');
  });
  it('names the recorded actor via Hornhoof', () => {
    const message = MessageEnvelopeSchema.parse({ direction: 'in', from: actor, to, notification: { source: 'reported', tasks: [{ id: 't1', number: 225 }] } });
    expect(messageHeading(message)).toBe('From Hana via Hornhoof, work reported on #225 to Bruno:');
  });
  it('rejects an unregistered source', () => {
    expect(MessageEnvelopeSchema.safeParse({ direction: 'in', from, to, notification: { source: 'unnamed_source', tasks: [] } }).success).toBe(false);
  });
  it('never prints a bare service heading for a legacy envelope', () => {
    expect(messageHeading({ direction: 'in', from, to } satisfies MessageEnvelope)).toBe('From Hornhoof, recorded service message to Bruno:');
  });
});
