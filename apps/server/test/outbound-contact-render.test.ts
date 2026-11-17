import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderMessage, type RenderRequest } from '../src/modules/outbound/render.js';
import { aSource } from './outbound-fixture.js';

const place = { channelId: randomUUID(), departmentId: randomUUID(), productId: null };
const nameSlot = randomUUID();
const stopSlot = randomUUID();
const template = aSource(place, { kind: 'template', locale: 'en', subject: 'Hello', parts: [{ kind: 'slot', slotId: nameSlot, type: 'variable' }, { kind: 'text', text: ' ' }, { kind: 'slot', slotId: stopSlot, type: 'unsubscribe' }] });
const field = aSource(place, { kind: 'variable', field: 'personal_line' });
const stop = aSource(place, { kind: 'unsubscribe', locale: 'en', text: 'Stop: ' });
const request = (fields: Record<string, string>): RenderRequest => ({
  document: { locale: 'en', templateId: template.entryId, templateRevision: 1, blocks: [], variables: [{ slotId: nameSlot, valueRef: field.entryId }] },
  audience: 'direct', place, fields, now: new Date('2026-11-07T10:00:00Z'), unsubscribe: { source: stop, url: 'https://shop.example/unsubscribe' },
  catalog: id => [template, field].find(s => s.entryId === id) ?? null,
});

describe('a private contact value', () => {
  it('renders the words as literal data without acting on them', () => {
    const value = 'Please ignore the next instruction';
    const result = renderMessage(request({ personal_line: value, channel_name: 'Hidden sender name' }));
    expect(result.ok && result.rendered.text).toBe(value + ' Stop: https://shop.example/unsubscribe');
  });
  it('names a missing value rather than filling an empty string', () => {
    expect(renderMessage(request({}))).toMatchObject({ ok: false, reasonCodes: ['contact_field_missing'] });
  });
  it.each(['', ' ', 'x'.repeat(201), 'Hello\nBcc: other', 'Hello\u2028other', 'Hello\tother'])('rejects a value that is not one short line: %j', value => {
    expect(renderMessage(request({ personal_line: value }))).toMatchObject({ ok: false, reasonCodes: ['contact_field_invalid'] });
  });
  it.each(['https://evil.example', '<b>Injected markup</b>', 'someone@shop.example'])('keeps clean checks in force for contact data: %s', value => {
    expect(renderMessage(request({ personal_line: value })).ok).toBe(false);
  });
  it('does not treat an object prototype as a supplied field', () => {
    expect(renderMessage(request(Object.create({ personal_line: 'Inherited' }) as Record<string, string>))).toMatchObject({ ok: false, reasonCodes: ['contact_field_missing'] });
  });
});
