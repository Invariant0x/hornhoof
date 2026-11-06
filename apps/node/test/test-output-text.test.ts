import { describe, expect, it } from 'vitest';
import { isValidTextOutput } from '../src/test-output-text.js';

describe('declared diagnostic text content', () => {
  it.each(['', 'complete log\nnext line\n', 'Русский текст 📏', '\u001b[31mfailed\u001b[0m\n'])('accepts exact UTF-8 log bytes %j', value => {
    expect(isValidTextOutput(Buffer.from(value), 'text/plain')).toBe(true);
  });
  it.each(['{"width":100,"height":200}', '[{"browser":"webkit","x":1.25}]', 'null', '0', '"text"'])('accepts syntactically valid geometry JSON %s without proving its measurements', value => {
    expect(isValidTextOutput(Buffer.from(value), 'application/json')).toBe(true);
  });
  it.each(['', '{"width":', '{"x":NaN}', '{"x":1,}', '{"x":1} trailing', 'undefined'])('refuses malformed JSON %j', value => {
    expect(isValidTextOutput(Buffer.from(value), 'application/json')).toBe(false);
  });
  it.each([
    { value: [0x80] }, { value: [0xc0, 0xaf] }, { value: [0xe2, 0x82] },
    { value: [0xed, 0xa0, 0x80] }, { value: [0xf4, 0x90, 0x80, 0x80] }, { value: [0xff, 0xfe, 0x61, 0x00] },
  ])('never replaces malformed UTF-8 bytes %# with plausible output text', ({ value }) => {
    const bytes = Buffer.from(value);
    expect(isValidTextOutput(bytes, 'text/plain')).toBe(false);
    expect(isValidTextOutput(Buffer.concat([Buffer.from('{"x":"'), bytes, Buffer.from('"}')]), 'application/json')).toBe(false);
  });
  it.each(['image/png', 'text/html', 'application/octet-stream', 'application/json; charset=utf-8', ''])('does not accept undeclared text type %j', mediaType => {
    expect(isValidTextOutput(Buffer.from('{}'), mediaType)).toBe(false);
  });
  it('validates without rewriting the bytes whose hash and size the reader records', () => {
    const bytes = Buffer.from('\ufeff{ "width" : 100 }\n'), before = Buffer.from(bytes);
    expect(isValidTextOutput(bytes, 'application/json')).toBe(true);
    expect(bytes).toEqual(before);
  });
});
