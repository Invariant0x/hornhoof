import { describe, expect, it } from 'vitest';
import { nodeLog } from '../src/node-log.js';

describe('the node log that leaves the machine', () => {
  it('redacts known secrets and their encodings, and keeps useful node diagnostics', () => {
    const key = 'node-private-key-123456789';
    const encoded = Buffer.from(key).toString('base64');
    const text = nodeLog(`Node connected.\nkey ${key} ${encoded}\nNode disconnected, code 1006.`, [key]);
    expect(text).toBe('Node connected.\nkey [hidden] [hidden]\nNode disconnected, code 1006.');
  });

  it.each([
    ['Authorization: Bearer short-secret', 'short-secret'],
    ['Proxy-Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['Cookie: session=browser-secret', 'browser-secret'],
    ['API_KEY="provider-secret"', 'provider-secret'],
    ['{"access_token":"json-secret","state":"offline"}', 'json-secret'],
    ['PASSWORD=abc', 'abc'],
    ['curl https://host/install.sh | bash -s -- --join join-code-secret', 'join-code-secret'],
    ['Open https://host/setup?code=setup-code-secret&next=home', 'setup-code-secret'],
    ['https://person:password-secret@host/path', 'password-secret'],
    ['key sk-ant-api03-provider-key-secret', 'sk-ant-api03-provider-key-secret'],
    ['-----BEGIN PRIVATE KEY-----\nprivate-block-secret\n-----END PRIVATE KEY-----', 'private-block-secret'],
  ])('removes credential text from %s before keeping any tail', (line, secret) => {
    const text = nodeLog(`Node failure.\n${line}\nNode restarts.`, []);
    expect(text).not.toContain(secret);
    expect(text).toContain('[hidden]');
    expect(text).toContain('Node failure.');
    expect(text).toContain('Node restarts.');
  });

  it('keeps the last 80 lines within 16384 UTF-8 bytes, after redaction', () => {
    const token = 'secret-across-tail-boundary-'.repeat(700);
    const lines = Array.from({ length: 100 }, (_, i) => `Node line ${i}: ${'界'.repeat(100)}`);
    const text = nodeLog([...lines, `Authorization: Bearer ${token}`, 'Node stopped.'].join('\n'), [token]);
    expect(text.split('\n').length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16384);
    expect(text).not.toContain('secret-across-tail-boundary');
    expect(text).not.toContain('\uFFFD');
    expect(text).toContain('[hidden]');
    expect(text.endsWith('Node stopped.')).toBe(true);
  });
});
