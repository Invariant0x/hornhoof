import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';

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
