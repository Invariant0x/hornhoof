import { expect, it } from 'vitest';
import { PRIVATE_TOOL_NOTE, ToolPrivacy } from '../src/tool-privacy.js';

it('hides contact values in direct and delegated tool transcripts', () => {
  for (const name of ['outbound_contact_add', 'use_tool']) {
    const privacy = new ToolPrivacy();
    const data = { fields: { name: 'Private sample', personal_line: 'Private invitation' }, address: 'private@shop.example' };
    const input = name === 'use_tool' ? { name: 'outbound_contact_add', arguments: data } : data;
    const event = privacy.event({ kind: 'tool', name, input: JSON.stringify(input) });
    expect(event).toMatchObject({ input: PRIVATE_TOOL_NOTE, sensitive: true });
    expect(privacy.values.text('Private sample Private invitation')).toBe('[hidden] [hidden]');
  }
});
