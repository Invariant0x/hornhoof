import { describe, expect, it } from 'vitest';
import { nodeLog } from '../src/node-log.js';

describe('the node log that leaves the machine', () => {
  it('redacts known secrets and their encodings, and keeps useful node diagnostics', () => {
    const key = 'node-private-key-123456789';
    const encoded = Buffer.from(key).toString('base64');
    const text = nodeLog(`Node connected.\nkey ${key} ${encoded}\nNode disconnected, code 1006.`, [key]);
    expect(text).toBe('Node connected.\nkey [hidden] [hidden]\nNode disconnected, code 1006.');
  });

  it('removes terminal escapes before matching an opaque secret split by color codes', () => {
    const secret = 'opaque-provider-123456789';
    expect(nodeLog('Node error: opaque-\u001b[31mprovider-123456789\u001b[0m', [secret])).toBe('Node error: [hidden]');
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

  it('removes an unfinished private key through the end of the message', () => {
    const text = nodeLog('Node failure.\n-----BEGIN PRIVATE KEY-----\nunfinished-private-block-secret', []);
    expect(text).toBe('Node failure.\n[hidden]');
  });

  it('redacts incomplete multiline quoted credentials and folded authorization headers', () => {
    for (const input of ['access_token="synthetic-first-line\nsynthetic-second-line', "password='synthetic-first-line\nsynthetic-second-line", 'Authorization: Bearer synthetic-first-line\n synthetic-second-line']) {
      const clean = nodeLog('Node error.\n' + input, []);
      expect(clean).not.toContain('synthetic-first-line');
      expect(clean).not.toContain('synthetic-second-line');
      expect(clean).toContain('Node error.');
    }
  });

  it('keeps diagnostic context around quoted secrets, including escapes and multiple labels', () => {
    expect(nodeLog('Provider error: access_token="private\\"part"; state=offline; password=\'another-private\'; retry=1', [])).toBe('Provider error: access_token=[hidden]; state=offline; password=[hidden]; retry=1');
    expect(nodeLog('Node token="first-private"; state=offline; password="second-private"; retry=1', [])).toBe('Node token=[hidden]; state=offline; password=[hidden]; retry=1');
    expect(nodeLog('Node token="private "; state=offline', [])).toBe('Node token=[hidden]; state=offline');
    expect(nodeLog('  at connect(node.ts:42)', [])).toBe('  at connect(node.ts:42)');
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
