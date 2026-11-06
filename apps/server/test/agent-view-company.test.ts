import { describe, expect, it } from 'vitest';
import { leaks } from './agent-view-company.js';

const hidden = [{ id: '00000000-0000-4000-8000-000000000123', name: 'Awa' }];
const response = (value: unknown) => ({ body: JSON.stringify(value) });

describe('hidden identity checks on real response values', () => {
  it('does not mistake a JSON key or a longer word for a hidden name', () => {
    expect(leaks(response({ machinesAway: [], Awa: 'public status', nested: ['machinesAway', 'Awa2', 'Аwa', 'Awa_away'] }), hidden)).toEqual([]);
  });
  it.each(['Awa', 'Work of Awa', '(Awa)', 'Awa: waiting', 'See "Awa" now'])('finds a hidden name in the value %s', value => {
    expect(leaks(response({ nested: [{ words: value }] }), hidden)).toEqual(['Awa']);
  });
  it('decodes JSON strings before looking for a hidden identity', () => {
    expect(leaks({ body: '{"name":"\\u0041wa"}' }, hidden)).toEqual(['Awa']);
  });
  it('still finds exact hidden IDs in values, URLs and dictionary keys', () => {
    for (const value of [hidden[0]!.id, `/api/agents/${hidden[0]!.id}`, { [hidden[0]!.id]: false }]) {
      expect(leaks(response(value), hidden)).toEqual([hidden[0]!.id]);
    }
  });
  it('does not discard non-JSON response bodies', () => {
    expect(leaks({ body: 'Hidden: Awa' }, hidden)).toEqual(['Awa']);
  });
  it('treats names as literal words, including regex punctuation', () => {
    const actor = [{ id: hidden[0]!.id, name: 'A.wa' }];
    expect(leaks(response({ message: 'A.wa waits.' }), actor)).toEqual(['A.wa']);
    expect(leaks(response({ message: 'Abwa waits.' }), actor)).toEqual([]);
  });
});
