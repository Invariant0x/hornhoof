import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeLifecycle, prepareNodeStop, stopNode } from '../src/lifecycle.js';

const FIRST = '2026-11-03T17:00:00.000Z';
const NEXT = '2026-11-03T17:47:00.000Z';
const dir = () => mkdtempSync(join(tmpdir(), 'hh-node-life-'));
const open = (path: string, startedAt: string, readOom = () => null as number | null, write: (line: string) => void = () => {}) =>
  nodeLifecycle({ dir: path, startedAt, secrets: () => ['node-token-123456789'], write, readOom });

describe('a persisted node lifecycle', () => {
  it('does not invent a previous exit on first start or after a corrupt journal', () => {
    const path = dir();
    expect(open(path, FIRST).previous).toMatchObject({ kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' });
    writeFileSync(join(path, 'node-runtime.json'), '{broken');
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'unknown', reason: 'unknown', startedAt: null });
  });

  it('keeps the real previous node log after a process dies without a completed stop', () => {
    const path = dir();
    const first = open(path, FIRST);
    first.log('Node socket closed with code 1006.');
    const next = open(path, NEXT);
    expect(next.previous).toMatchObject({ startedAt: FIRST, at: null, kind: 'unplanned', reason: 'unclean_exit', log: expect.stringContaining('Node socket closed with code 1006.') });
  });

  it('records a completed planned update and sends only sanitized output', () => {
    const path = dir();
    const output: string[] = [];
    const first = open(path, FIRST, () => null, line => output.push(line));
    first.log('Authorization: Bearer bearer-secret-123');
    first.log('Node key node-token-123456789');
    prepareNodeStop(path, 'node_update');
    const stopped = first.stop('stopped');
    expect(stopped).toMatchObject({ startedAt: FIRST, kind: 'planned', reason: 'node_update', at: expect.any(String) });
    expect(first.stop('stopped')).toEqual(stopped);
    const persisted = readFileSync(join(path, 'node-runtime.json'), 'utf8');
    for (const secret of ['bearer-secret-123', 'node-token-123456789']) {
      expect(persisted).not.toContain(secret);
      expect(output.join('\n')).not.toContain(secret);
      expect(stopped.log).not.toContain(secret);
    }
    expect(statSync(join(path, 'node-runtime.json')).mode & 0o777).toBe(0o600);
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'planned', reason: 'node_update', startedAt: FIRST });
  });

  it('never mistakes a prepared update for a completed graceful stop', () => {
    const path = dir();
    open(path, FIRST).log('Node update requested.');
    prepareNodeStop(path, 'hornhoof_update');
    const next = open(path, NEXT);
    expect(next.previous).toMatchObject({ kind: 'unplanned', reason: 'unclean_exit' });
    expect(next.stop('stopped')).toMatchObject({ reason: 'stopped' });
  });

  it('ignores late callbacks from a stopped process after the next process opens its journal', () => {
    const path = dir();
    const first = open(path, FIRST);
    first.stop('stopped');
    open(path, NEXT);
    first.log('Late close from the old socket.');
    expect(JSON.parse(readFileSync(join(path, 'node-runtime.json'), 'utf8'))).toMatchObject({ startedAt: NEXT, exit: null });
  });

  it('reports an increased cgroup OOM counter as evidence without blaming the node process', () => {
    const path = dir();
    open(path, FIRST, () => 3);
    expect(open(path, NEXT, () => 4).previous).toMatchObject({ kind: 'unplanned', reason: 'unclean_exit', log: expect.stringContaining('Memory cgroup OOM kills: 3 -> 4.') });
    const unknown = dir();
    open(unknown, FIRST);
    expect(open(unknown, NEXT, () => 4).previous).toMatchObject({ reason: 'unclean_exit' });
  });

  it('does not report unchanged OOM counters as a new event', () => {
    const path = dir();
    open(path, FIRST, () => 3);
    expect(open(path, NEXT, () => 3).previous.log).not.toContain('OOM');
  });

  it.skipIf(!existsSync('/sys/fs/cgroup/memory.events'))('records the actual kernel OOM counter before a possible crash', () => {
    const path = dir();
    nodeLifecycle({ dir: path, startedAt: FIRST, secrets: () => [], write: () => {} });
    const lines = readFileSync('/sys/fs/cgroup/memory.events', 'utf8').split('\n');
    const counter = Number(lines.find(line => line.startsWith('oom_kill '))!.split(' ')[1]);
    expect(JSON.parse(readFileSync(join(path, 'node-runtime.json'), 'utf8')).oomKills).toBe(counter);
  });

  it('accepts a journal at the read limit and rejects one byte over it', () => {
    const path = dir();
    const record = JSON.stringify({ startedAt: FIRST, log: 'Previous safe diagnostic.', exit: null, oomKills: null }).padEnd(128 * 1024, ' ');
    writeFileSync(join(path, 'node-runtime.json'), record);
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'unplanned', log: expect.stringContaining('Previous safe diagnostic.') });
    writeFileSync(join(path, 'node-runtime.json'), record + ' ');
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'unknown', log: '' });
  });

  it('persists a completed stop even when the socket is absent', () => {
    const path = dir();
    stopNode(open(path, FIRST), null, FIRST, 'stopped');
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'planned', reason: 'stopped' });
  });

  it('bounds the persisted log as well as the transmitted tail', () => {
    const path = dir();
    const life = open(path, FIRST);
    for (let i = 0; i < 100; i++) life.log(`Node diagnostic ${i}: ${'界'.repeat(200)}`);
    expect(Buffer.byteLength(life.tail())).toBeLessThanOrEqual(16384);
    expect(life.tail().split('\n').length).toBeLessThanOrEqual(80);
    const stored = JSON.parse(readFileSync(join(path, 'node-runtime.json'), 'utf8'));
    expect(stored.log).toBe(life.tail());
    expect(stored.log).toContain('Node diagnostic 99');
  });

  it('redacts a private key arriving in separate messages before any persistence or output', () => {
    const path = dir();
    const output: string[] = [];
    const life = open(path, FIRST, () => null, line => output.push(line));
    life.log('-----BEGIN PRIVATE KEY-----');
    life.log('private-key-body-split-across-messages');
    expect(readFileSync(join(path, 'node-runtime.json'), 'utf8')).not.toContain('private-key-body');
    expect(output.join('\n')).not.toContain('private-key-body');
    life.log('-----END PRIVATE KEY-----');
    life.log('Connection closed.');
    expect(life.tail()).toContain('Connection closed.');
  });

  it('keeps working when journal writes fail and never fabricates a persisted clean stop', () => {
    const path = dir();
    const output: string[] = [];
    const life = open(path, FIRST, () => null, line => output.push(line));
    const journal = join(path, 'node-runtime.json');
    renameSync(journal, journal + '.saved');
    mkdirSync(journal);
    expect(() => life.log('Connection closed. Authorization: Bearer opaque-private-value')).not.toThrow();
    expect(life.tail()).toContain('Connection closed.');
    expect(output.join('\n')).not.toContain('opaque-private-value');
    expect(output.join('\n')).toContain('journal');
    expect(() => life.stop('stopped')).not.toThrow();
    expect(output.filter(line => line.includes('journal'))).toHaveLength(1);
    rmSync(journal, { recursive: true });
    renameSync(journal + '.saved', journal);
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'unplanned', reason: 'unclean_exit' });
  });

  it('starts with memory evidence when the journal is unavailable', () => {
    const path = dir();
    mkdirSync(join(path, 'node-runtime.json'));
    const output: string[] = [];
    const life = open(path, FIRST, () => null, line => output.push(line));
    expect(life.previous.kind).toBe('unknown');
    life.log('Connection opened.');
    expect(life.tail()).toContain('Connection opened.');
    expect(output.join('\n')).toContain('journal');
  });

  it('redacts quoted credential continuations and folded headers across callbacks', () => {
    const path = dir();
    const output: string[] = [];
    const life = open(path, FIRST, () => null, line => output.push(line));
    life.log('Provider error: access_token="synthetic-first-line');
    life.log('synthetic-second-line');
    life.log('synthetic-third-line"; state=offline');
    life.log('Authorization: Bearer first-header-line');
    life.log(' second-header-line');
    life.log('Node reconnecting.');
    const stored = readFileSync(join(path, 'node-runtime.json'), 'utf8');
    for (const text of [stored, output.join('\n'), life.tail(), life.stop('stopped').log]) {
      for (const secret of ['synthetic-first-line', 'synthetic-second-line', 'synthetic-third-line', 'first-header-line', 'second-header-line']) expect(text).not.toContain(secret);
      expect(text).toContain('state=offline');
      expect(text).toContain('Node reconnecting.');
    }
  });

  it('reads back every valid bounded tail after JSON escaping', () => {
    const path = dir();
    const life = open(path, FIRST);
    life.log('Node diagnostics: ' + '\u0000'.repeat(16300));
    life.stop('node_update');
    expect(open(path, NEXT).previous).toMatchObject({ kind: 'planned', reason: 'node_update', log: expect.stringContaining('Node diagnostics:') });
  });

  it('resumes diagnostic text after a multiline credential closes at the start of a callback', () => {
    const path = dir();
    const output: string[] = [];
    const life = open(path, FIRST, () => null, line => output.push(line));
    life.log('Provider error: token="private-first-line');
    life.log('"; state=offline; password="second-private"; retry=1');
    expect(output.at(-1)).toBe('[hidden]; state=offline; password=[hidden]; retry=1');
    life.log('Node reconnecting.');
    expect(output.at(-1)).toBe('Node reconnecting.');
  });
});
