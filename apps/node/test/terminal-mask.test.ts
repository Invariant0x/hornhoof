import { describe, expect, it } from 'vitest';
import { StreamMask } from '../src/terminal/mask.js';

const SECRET = 'tok-1234567890abcdef';

describe('hiding secrets on a live screen', () => {
  it('hides a secret the screen sends in two pieces', () => {
    const mask = new StreamMask(() => [SECRET]);
    const out = mask.push('abc tok-12345') + mask.push('67890abcdef end') + mask.flush();
    expect(out).toBe('abc [hidden] end');
  });

  it('sends plain text at once, and holds only what could start a secret', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('hello ')).toBe('hello ');
    expect(mask.push('see tok-')).toBe('see ');
    expect(mask.push('x')).toBe('tok-x');
  });

  it('gives back what it held when the screen goes quiet', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('the end tok')).toBe('the end ');
    expect(mask.flush()).toBe('tok');
  });

  it('hides a secret the agent printed in base64', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push(`key ${Buffer.from(SECRET).toString('base64')} ok`) + mask.flush()).toBe('key [hidden] ok');
  });

  it('hides a long start of a secret when the screen goes quiet on it', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('key tok-1234567')).toBe('key ');
    expect(mask.flush()).toBe('[hidden]');
  });

  it('hides the rest of a secret whose short start went out on a quiet screen', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('see tok-') + mask.flush()).toBe('see tok-');
    expect(mask.push('1234567890abcdef end') + mask.flush()).toBe('[hidden] end');
  });

  it('keeps a secret hidden when it comes one quiet piece at a time, as an answer streams', () => {
    const mask = new StreamMask(() => [SECRET]);
    const out = [...SECRET].map(c => mask.push(c) + mask.flush()).join('');
    expect(out.replaceAll('[hidden]', '')).toBe('tok-123');
  });

  it('forgets a start that the screen did not go on with', () => {
    const mask = new StreamMask(() => [SECRET]);
    expect(mask.push('tok') + mask.flush()).toBe('tok');
    expect(mask.push('en ok') + mask.flush()).toBe('en ok');
  });
});

describe('a control sequence that ends in the first letter of a secret', () => {
  const VALUE = 'Hsecret-value-1';
  const SEQUENCE = '\x1b[1;2H';
  const mask = () => new StreamMask(() => [VALUE]);

  it('goes out at once and whole, as it draws nothing', () => {
    const m = mask();
    expect(m.push(`frame${SEQUENCE}`)).toBe(`frame${SEQUENCE}`);
    expect(m.flush()).toBe('');
  });

  it.each([['\x1b[0m', 'msecret-value'], ['\x1b[?25h', 'hsecret-value'], ['\x1b[K', 'Ksecret-value'], ['\x1b[1;2H', '2Hsecret-value']])('goes out at once for %j and a secret %s', (sequence, value) => {
    expect(new StreamMask(() => [value]).push(`frame${sequence}`)).toBe(`frame${sequence}`);
  });

  it('hides the rest of the secret when it comes after it', () => {
    const m = mask();
    expect(m.push(SEQUENCE)).toBe(SEQUENCE);
    expect(m.push('secret-value-1 end')).toBe('[hidden] end');
  });

  it('hides the rest of the secret that comes in pieces after it', () => {
    const m = mask();
    expect(m.push(SEQUENCE) + m.push('secre') + m.push('t-value-1 end') + m.flush()).toBe(`${SEQUENCE}[hidden] end`);
  });

  it('hides a whole secret that comes after it', () => {
    const m = mask();
    expect(m.push(SEQUENCE) + m.push(`${VALUE} end`) + m.flush()).toBe(`${SEQUENCE}[hidden] end`);
  });

  it('forgets it when the screen goes on with something else', () => {
    const m = mask();
    m.push(SEQUENCE);
    expect(m.push('plain')).toBe('plain');
    expect(m.push('secret-value-1')).toBe('secret-value-1');
  });

  it('shows no secret, wherever the pieces end', () => {
    const text = `${SEQUENCE}${VALUE} end`;
    for (let at = 1; at < text.length; at++) {
      const m = mask();
      expect(m.push(text.slice(0, at)) + m.push(text.slice(at)) + m.flush(), `split at ${at}`).toBe(`${SEQUENCE}[hidden] end`);
    }
  });

  it('shows no rest of a secret right after the sequence, wherever the pieces end', () => {
    const text = `${SEQUENCE}secret-value-1 end`;
    for (let at = 1; at < text.length; at++) {
      const m = mask();
      const out = m.push(text.slice(0, at)) + m.push(text.slice(at)) + m.flush();
      expect(out, `split at ${at}`).toContain('[hidden] end');
      expect(out, `split at ${at}`).not.toContain('secret-value-1');
    }
  });

  it('hides each form of a secret the same way', () => {
    const form = Buffer.from(VALUE).toString('base64');
    const m = new StreamMask(() => [VALUE]);
    const sequence = `\x1b[1;2${form[0]}`;
    expect(m.push(sequence)).toBe(sequence);
    expect(m.push(`${form.slice(1)} end`)).toBe('[hidden] end');
  });
});

describe('what the mask still holds at the end of a piece', () => {
  it('holds a letter that follows a control sequence', () => {
    const mask = new StreamMask(() => ['Hsecret-value-1']);
    expect(mask.push('\x1b[1;2HH')).toBe('\x1b[1;2H');
    expect(mask.flush()).toBe('H');
  });

  it('holds a letter alone', () => {
    const mask = new StreamMask(() => ['Hsecret-value-1']);
    expect(mask.push('H')).toBe('');
    expect(mask.flush()).toBe('H');
  });

  it('holds what could start a secret in a sequence not finished yet', () => {
    const mask = new StreamMask(() => ['12secret-value']);
    expect(mask.push('\x1b[12')).toBe('\x1b[');
  });

  it('holds a whole sequence that a secret starts with', () => {
    const mask = new StreamMask(() => ['\x1b[1mvalue-1234']);
    expect(mask.push('text\x1b[1m')).toBe('text');
  });

  it('holds a start from before a sequence that a secret goes on through', () => {
    const mask = new StreamMask(() => ['ab\x1b[1mvalue-1234']);
    expect(mask.push('ab\x1b[1m')).toBe('');
    expect(mask.push('value-1234 end')).toBe('[hidden] end');
  });
});

