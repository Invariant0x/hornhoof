import { describe, expect, it } from 'vitest';
import { hideKeyLike, redact } from '../src/redact.js';

describe('redact', () => {
  it('hides a token, its base64 form and every copy', () => {
    const token = 'sk-ant-oat01-abcdefghijklmnop';
    const b64 = Buffer.from(token).toString('base64');
    const text = `key=${token} again ${token} encoded ${b64}`;
    expect(redact(text, [token])).toBe('key=[hidden] again [hidden] encoded [hidden]');
  });

  it('leaves short values alone', () => {
    expect(redact('the word true stays', ['true', ''])).toBe('the word true stays');
  });
});

describe('words that look like a key', () => {
  it.each([
    ['sk-ant-api03-q9Zx7Tb2Vn8Lp0Wr4Ks', 'key [hidden] refused'],
    ['ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6', 'key [hidden] refused'],
    ['AbCd1234EfGh5678IjKl9012MnOp', 'key [hidden] refused'],
    ['0123456789abcdef0123456789abcdef', 'key [hidden] refused'],
    ['Bearer marker7c41abcdefghijklmnopqrstuvwxyz', 'key Bearer [hidden] refused'],
    ['Basic dXNlcjpwYXNz', 'key Basic [hidden] refused'],
  ])('hides %s', (key, shown) => {
    expect(hideKeyLike(`key ${key} refused`)).toBe(shown);
  });

  it.each([
    'Error: claude native binary not installed. Either postinstall did not run ... or the platform-native optional dependency was not downloaded (--omit=optional)',
    "Error: Cannot find module '/data/tools/lib/node_modules/@anthropic-ai/claude-code-linux-x64/cli.js'",
    'npm ERR! code ECONNRESET at https://registry.npmjs.org/@anthropic-ai/claude-code',
  ])('leaves ordinary words as they are: %s', words => {
    expect(hideKeyLike(words)).toBe(words);
  });
});
