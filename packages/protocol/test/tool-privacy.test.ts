import { describe, expect, it } from 'vitest';
import { PRIVATE_TOOL_NOTE, PrivateValues, ToolPrivacy, isSensitiveTool } from '../src/tool-privacy.js';

describe('sensitive tool telemetry', () => {
  it('masks short secrets in reports without changing identifiers or event discriminants', () => {
    const values = new PrivateValues();
    values.remember('text');
    values.remember('a');
    expect(values.hide({ task: 'a', kind: 'text', type: 'text', text: 'a text report' })).toEqual({ task: 'a', kind: 'text', type: 'text', text: '[hidden] [hidden] report' });
    const args = { wait: 'a0000000-0000-4000-8000-000000000000', riskClass: 'data', workKind: 'legacy', skills: { on: ['data'], off: [] }, summary: 'a text report' };
    expect(values.input(args)).toEqual({ ...args, summary: '[hidden] [hidden] report' });
    expect(JSON.parse(values.hide(JSON.stringify({ task: 'a', riskClass: 'data', summary: 'a report' }))))
      .toEqual({ task: 'a', riskClass: 'data', summary: '[hidden] report' });
  });

  it('keeps safe reports and hides values even when they are short, escaped or regex characters', () => {
    const values = new PrivateValues();
    values.remember('i');
    values.remember('a.$"\n');
    expect(values.text('i')).toBe('[hidden]');
    expect(values.hide({ text: 'Ready.', nested: JSON.stringify({ password: 'a.$"\n' }) })).toEqual({ text: 'Ready.', nested: '{"password":"[hidden]"}' });
  });

  it('preserves media bytes when a short password also occurs in their base64 representation', () => {
    const values = new PrivateValues();
    values.remember('a');
    const image = { content: [{ type: 'image', data: 'aaaa', mimeType: 'image/png' }] };
    expect(values.hide(image)).toEqual(image);
  });

  it('enables execution only from remembered values, then protects later captures of that executor', () => {
    const privacy = new ToolPrivacy();
    expect(privacy.execution('another_executor', { text: 'private-marker', secretExecution: true })).toBe(false);
    privacy.input('vault_save', { password: 'private-marker' });
    expect(privacy.execution('another_executor', { kind: 'capture', secretExecution: true })).toBe(false);
    expect(privacy.execution('another_executor', { text: 'private-marker', secretExecution: false })).toBe(true);
    expect(privacy.execution('another_executor', { kind: 'capture' })).toBe(true);
    expect(privacy.execution('other_executor', { kind: 'capture' })).toBe(false);
    expect(privacy.values.input({ subject: 'Use private-marker', freshText: 'Keep private-marker' })).toEqual({ subject: 'Use [hidden]', freshText: 'Keep [hidden]' });
  });

  it('learns a plain value from any tool carrying the sensitive flag', () => {
    const privacy = new ToolPrivacy();
    privacy.event({ kind: 'tool', name: 'new_secret_tool', sensitive: true, input: '{}' });
    privacy.event({ kind: 'tool_result', ok: true, summary: 'private-result-marker' });
    expect(privacy.event({ kind: 'text', text: 'Ready with private-result-marker.' })).toEqual({ kind: 'text', text: 'Ready with [hidden].' });
  });

  it.each(['vault_entry', 'hornhoof.vault_save', 'mcp__hornhoof__vault_entry'])('recognizes the shared definition of %s', name => {
    expect(isSensitiveTool(name)).toBe(true);
    expect(isSensitiveTool(`${name}_public`)).toBe(false);
  });

  it('keeps ordinary telemetry, then hides all data after a sensitive call, irrespective of the value', () => {
    const privacy = new ToolPrivacy();
    expect(privacy.event({ kind: 'tool_result', ok: true, summary: 'ordinary' })).toEqual({ kind: 'tool_result', ok: true, summary: 'ordinary' });
    expect(privacy.event({ kind: 'tool', name: 'new_secret_tool', sensitive: true, input: 'private-marker' })).toMatchObject({ input: PRIVATE_TOOL_NOTE });
    privacy.values.remember('private-marker');
    const events = [
      privacy.event({ kind: 'tool_result', ok: true, summary: 'private-marker' }),
      privacy.event({ kind: 'tool', name: 'shell', input: 'type private-marker' }),
      privacy.event({ kind: 'text', text: 'private-marker' }),
      privacy.event({ kind: 'todo', items: [{ text: 'private-marker', state: 'todo' }] }),
    ];
    expect(JSON.stringify(events)).not.toContain('private-marker');
    expect(privacy.sensitive).toBe(true);
    expect(new ToolPrivacy().sensitive).toBe(false);
  });
});
