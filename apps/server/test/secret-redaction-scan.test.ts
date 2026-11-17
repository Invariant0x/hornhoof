import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TableFacts } from '../src/modules/merge/facts.js';
import { fingerprintMask, fingerprintOf, maskJson, maskRow, proseColumns, valueMask, windowHashOf } from '../src/modules/tasks/hide-secret.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const table = (name: string, columns: [string, string][]): TableFacts => ({ name, columns: columns.map(([column, type]) => ({ name: column, type, nullable: true })), key: ['id'], fks: [], referencedBy: [] });
const both = (values: string[], text: string) => {
  const byValue = [...values].sort((a, b) => [...b].length - [...a].length).reduce((result, value) => valueMask(value)(result), text);
  const byFingerprint = fingerprintMask(values.map(fingerprintOf))!(text);
  return { byValue, byFingerprint };
};

describe('a hidden value found again by its fingerprint', () => {
  it.each([
    ['ascii', ['Secret1077!'], 'before Secret1077! between Secret1077!after'],
    ['start and end', ['Secret1077!'], 'Secret1077!Secret1077!'],
    ['overlapping runs', ['aaaaaaaa'], 'a'.repeat(17)],
    ['code points', ['ключ🔑1077!'], 'старый ключ🔑1077! и ключ🔑1077'],
    ['across an earlier mask', ['n]secret1'], '[hidden]secret1 and n]secret1'],
    ['the longest first', ['abcdefgh', 'abcdefghij'], 'abcdefghij abcdefgh'],
    ['absent', ['Secret1077!'], 'nothing of it here, Secret1077 is one short'],
  ])('masks %s exactly as the value itself would', (_name, values, text) => {
    const { byValue, byFingerprint } = both(values, text);
    expect(byFingerprint).toBe(byValue);
  });

  it('gives the expected masks', () => {
    expect(both(['aaaaaaaa'], 'a'.repeat(17)).byFingerprint).toBe('[hidden][hidden]a');
    expect(both(['n]secret1'], '[hidden]secret1 and n]secret1').byFingerprint).toBe('[hidden]secret1 and [hidden]');
    expect(both(['abcdefgh', 'abcdefghij'], 'abcdefghij abcdefgh').byFingerprint).toBe('[hidden] [hidden]');
  });

  it('confirms every window with the full hash, so a rolling hash alone never masks', () => {
    const value = 'Secret1077!';
    const forged = { ...fingerprintOf(value), fingerprint: sha('Another1077') };
    expect(fingerprintMask([forged])!(`text ${value} text`)).toBe(`text ${value} text`);
  });

  it('has nothing to look for without fingerprints, and keeps its window hash below the modulus', () => {
    expect(fingerprintMask([])).toBeNull();
    for (const value of ['Secret1077!', '🔑'.repeat(40), 'z'.repeat(5000)]) expect(windowHashOf(value)).toBeGreaterThanOrEqual(0);
    expect(windowHashOf('z'.repeat(5000))).toBeLessThan(2 ** 31 - 1);
  });
});

describe('the prose of a stored row', () => {
  const mask = valueMask('Secret1077!');

  it('masks strings and their own names, never service state', () => {
    const data = { kind: 'Secret1077!', id: 'Secret1077!', task_id: 'Secret1077!', text: 'x Secret1077!', 'Secret1077!': 'Secret1077!', nested: [{ note: 'Secret1077!', at: 'Secret1077!' }], count: 3 };
    expect(maskJson(data, mask)).toEqual({ kind: 'Secret1077!', id: 'Secret1077!', task_id: 'Secret1077!', text: 'x [hidden]', '[hidden]': '[hidden]', nested: [{ note: '[hidden]', at: 'Secret1077!' }], count: 3 });
  });

  it('changes only prose columns and returns null when nothing changed', () => {
    const tasks = table('tasks', [['id', 'uuid'], ['body', 'text'], ['status', 'text'], ['paused', 'jsonb'], ['number', 'integer']]);
    expect(proseColumns(tasks)).toEqual(['body', 'paused']);
    expect(maskRow(tasks, { id: '1', body: 'a Secret1077!', status: 'Secret1077!', paused: { by: 'Secret1077!' }, number: 1 }, mask)).toEqual({ body: 'a [hidden]', paused: { by: '[hidden]' } });
    expect(maskRow(tasks, { id: '1', body: 'plain', status: 'Secret1077!' }, mask)).toBeNull();
    expect(proseColumns(table('secret_redactions', [['id', 'uuid'], ['text', 'text']]))).toEqual([]);
  });

  it('masks a text file and its size, never a picture or bytes that are no text', () => {
    const files = table('attachments', [['id', 'uuid'], ['media_type', 'text'], ['bytes', 'bytea'], ['size', 'integer']]);
    const hex = (bytes: Buffer) => `\\x${bytes.toString('hex')}`;
    const text = Buffer.from('saved Secret1077! text');
    expect(maskRow(files, { id: '1', media_type: 'text/plain', bytes: hex(text), size: text.length }, mask)).toEqual({ bytes: hex(Buffer.from('saved [hidden] text')), size: 19 });
    expect(maskRow(files, { id: '1', media_type: 'image/png', bytes: hex(text), size: text.length }, mask)).toBeNull();
    const broken = Buffer.concat([Buffer.from([0xff, 0xfe]), text]);
    expect(maskRow(files, { id: '1', media_type: 'text/plain', bytes: hex(broken), size: broken.length }, mask)).toBeNull();
  });
});
