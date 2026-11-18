import { describe, expect, it } from 'vitest';
import { PrivateValues, ToolPrivacy, isSensitiveTool } from '../src/tool-privacy.js';

describe('sensitive tool telemetry', () => {
  it('shows the name of an entry and its site and login with only the returned values masked', () => {
    const privacy = new ToolPrivacy();
    const input = JSON.stringify({ entry: 'Partner' });
    const answer = { name: 'Partner', site: 'https://example.test', login: 'nora', password: 'zx', code: '081804' };
    expect(privacy.event({ kind: 'tool', name: 'vault_entry', input })).toEqual({ kind: 'tool', name: 'vault_entry', input, sensitive: true });
    const result = privacy.event({ kind: 'tool_result', ok: true, summary: JSON.stringify(answer) });
    expect(result).toEqual({ kind: 'tool_result', ok: true, summary: JSON.stringify({ ...answer, password: '[hidden]', code: '[hidden]' }) });
    expect(privacy.event({ kind: 'tool_result', ok: true, summary: 'Signed in.' })).toEqual({ kind: 'tool_result', ok: true, summary: 'Signed in.' });
    expect(privacy.event({ kind: 'tool_result', ok: true, summary: '{"code":"200","status":"OK"}' })).toEqual({ kind: 'tool_result', ok: true, summary: '{"code":"200","status":"OK"}' });
  });

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

  it('masks a source repair report while preserving its verification identity', () => {
    const values = new PrivateValues();
    values.remember('private-repair-report-marker');
    const report = { task: 1178, summary: 'Repair required.', verification: { candidateId: 'candidate-id', revision: 3, delta: 'Repair private-repair-report-marker.' } };
    expect(values.input(report)).toEqual({ ...report, verification: { ...report.verification, delta: 'Repair [hidden].' } });
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
    expect(privacy.execution('url_executor', { operation: { kind: 'url', url: 'https://example.test/?value=private-marker' } })).toBe(true);
    expect(privacy.values.input({ subject: 'Use private-marker', freshText: 'Keep private-marker' })).toEqual({ subject: 'Use [hidden]', freshText: 'Keep [hidden]' });
  });

  it('learns a plain value from any tool carrying the sensitive flag', () => {
    const privacy = new ToolPrivacy();
    privacy.event({ kind: 'tool', name: 'new_secret_tool', sensitive: true, input: '{}' });
    privacy.event({ kind: 'tool_result', ok: true, summary: 'private-result-marker' });
    expect(privacy.event({ kind: 'text', text: 'Ready with private-result-marker.' })).toEqual({ kind: 'text', text: 'Ready with [hidden].' });
  });

  it('protects a sensitive tool called through the orchestrator shelf', () => {
    const privacy = new ToolPrivacy();
    const input = JSON.stringify({ name: 'vault_save', arguments: { password: 'private-shelf-marker' } });
    expect(privacy.event({ kind: 'tool', name: 'hornhoof.use_tool', input })).toMatchObject({ input: '{"name":"vault_save","arguments":{"password":"[hidden]"}}' });
    expect(privacy.event({ kind: 'text', text: 'Saved private-shelf-marker.' })).toEqual({ kind: 'text', text: 'Saved [hidden].' });
  });

  it('uses a registered policy for telemetry and keeps an explicit sensitive event private', () => {
    const privacy = new ToolPrivacy();
    const policy = { sensitive: true, secretInput: ['value'], secretOutput: ['value'] };
    expect(privacy.event({ kind: 'tool', name: 'new_private_tool', input: '{"value":"private-policy-marker"}' }, policy)).toMatchObject({ input: '{"value":"[hidden]"}' });
    expect(privacy.event({ kind: 'text', text: 'Done with private-policy-marker.' })).toEqual({ kind: 'text', text: 'Done with [hidden].' });
    const hinted = new ToolPrivacy();
    expect(hinted.event({ kind: 'tool', name: 'phone_action', sensitive: true, input: '{}' })).toMatchObject({ input: '{}' });
    expect(hinted.sensitive).toBe(true);
  });

  it.each(['vault_entry', 'hornhoof.vault_save', 'mcp__hornhoof__vault_entry'])('recognizes the shared definition of %s', name => {
    expect(isSensitiveTool(name)).toBe(true);
    expect(isSensitiveTool(`${name}_public`)).toBe(false);
  });

  it('keeps ordinary telemetry and masks only known values after a sensitive call', () => {
    const privacy = new ToolPrivacy();
    expect(privacy.event({ kind: 'tool_result', ok: true, summary: 'ordinary' })).toEqual({ kind: 'tool_result', ok: true, summary: 'ordinary' });
    expect(privacy.event({ kind: 'tool', name: 'new_secret_tool', sensitive: true, input: 'private-marker' })).toMatchObject({ input: '[hidden]' });
    privacy.values.remember('private-marker');
    const events = [
      privacy.event({ kind: 'tool_result', ok: true, summary: 'private-marker' }),
      privacy.event({ kind: 'tool', name: 'shell', input: 'type private-marker' }),
      privacy.event({ kind: 'text', text: 'private-marker' }),
      privacy.event({ kind: 'todo', items: [{ text: 'private-marker', state: 'todo' }] }),
    ];
    expect(JSON.stringify(events)).not.toContain('private-marker');
    expect(privacy.event({ kind: 'todo', items: [{ text: 'Keep going.', state: 'todo' }] })).toEqual({ kind: 'todo', items: [{ text: 'Keep going.', state: 'todo' }] });
    expect(privacy.sensitive).toBe(true);
    expect(new ToolPrivacy().sensitive).toBe(false);
  });
});
