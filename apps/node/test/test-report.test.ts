import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectKept, parseFileReport, readJobFile, restoreKept } from '../src/test-report.js';

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = (): string => { const dir = mkdtempSync(join(tmpdir(), 'hh-report-')); folders.push(dir); return dir; };
const me = process.getuid!();
const context = (over: object = {}) => ({ checkout: '/work/repo', suiteId: 'unit', selected: ['test/a.test.ts', 'test/b.test.ts'], suiteFailed: true, ...over });
const report = (files: object[]) => JSON.stringify({ files });

describe('what a runner reports of its files', () => {
  it('names each selected file from the repository root, absolute or relative alike', () => {
    expect(parseFileReport(report([{ file: '/work/repo/test/a.test.ts', status: 'failed', ms: 12.5 }, { file: 'test/b.test.ts', status: 'passed' }]), context())).toEqual([
      { suiteId: 'unit', file: 'test/a.test.ts', status: 'failed', ms: 12.5 },
      { suiteId: 'unit', file: 'test/b.test.ts', status: 'passed' },
    ]);
  });

  it('leaves out what it was not asked to run', () => {
    expect(parseFileReport(report([{ file: 'test/other.test.ts', status: 'passed' }, { file: '/etc/passwd', status: 'passed' }, { file: 'test/a.test.ts', status: 'failed' }]), context())).toEqual([{ suiteId: 'unit', file: 'test/a.test.ts', status: 'failed' }]);
  });

  it('says nothing when a suite failed and no file did: the failure belongs to no one file', () => {
    expect(parseFileReport(report([{ file: 'test/a.test.ts', status: 'passed' }]), context())).toEqual([]);
    expect(parseFileReport(report([{ file: 'test/a.test.ts', status: 'passed' }]), context({ suiteFailed: false }))).toEqual([{ suiteId: 'unit', file: 'test/a.test.ts', status: 'passed' }]);
  });

  it('passes on what a runner says a result came to', () => {
    expect(parseFileReport(report([{ file: 'test/a.test.ts', status: 'passed', note: '2 killed, 7 survived' }]), context({ suiteFailed: false }))).toEqual([{ suiteId: 'unit', file: 'test/a.test.ts', status: 'passed', note: '2 killed, 7 survived' }]);
  });

  it.each([['a note the server would refuse', report([{ file: 'test/a.test.ts', status: 'failed', note: 'two\nlines' }])], ['not JSON', '{nope'], ['another shape', '{"files":{}}'], ['another status', report([{ file: 'test/a.test.ts', status: 'skipped' }])], ['a negative time', report([{ file: 'test/a.test.ts', status: 'passed', ms: -1 }])], ['no report', null]])('says nothing for %s', (_name, text) => {
    expect(parseFileReport(text, context())).toEqual([]);
  });
});

describe('a file a job left', () => {
  it('reads when it is the job user’s own plain file', () => {
    const dir = folder(); writeFileSync(join(dir, 'a'), 'text');
    expect(readJobFile(join(dir, 'a'), me, 100)).toBe('text');
  });

  it('is left alone as a link, a folder, too large, missing or someone else’s', () => {
    const dir = folder(); writeFileSync(join(dir, 'a'), 'text'); symlinkSync(join(dir, 'a'), join(dir, 'link')); mkdirSync(join(dir, 'sub'));
    expect(readJobFile(join(dir, 'link'), me, 100)).toBeNull();
    expect(readJobFile(join(dir, 'sub'), me, 100)).toBeNull();
    expect(readJobFile(join(dir, 'a'), me, 2)).toBeNull();
    expect(readJobFile(join(dir, 'none'), me, 100)).toBeNull();
    expect(readJobFile(join(dir, 'a'), me + 1, 100)).toBeNull();
  });
});

describe('what a suite keeps between runs', () => {
  const kept = [{ path: '.metrics/mutate/a.edn', text: 'one' }, { path: '.metrics/mutate/deep/b.edn', text: 'two' }];

  it('comes back where it was', () => {
    const repo = folder();
    restoreKept(repo, ['.metrics/mutate'], kept);
    expect(readFileSync(join(repo, '.metrics/mutate/deep/b.edn'), 'utf8')).toBe('two');
    expect(collectKept(repo, ['.metrics/mutate'], me).sort((a, b) => a.path.localeCompare(b.path))).toEqual(kept);
  });

  it('leaves out what came back as it went in: another part of the run may change that file meanwhile', () => {
    const repo = folder();
    restoreKept(repo, ['.metrics/mutate'], kept);
    writeFileSync(join(repo, '.metrics/mutate/a.edn'), 'changed');
    writeFileSync(join(repo, '.metrics/mutate/new.edn'), 'new');
    expect(collectKept(repo, ['.metrics/mutate'], me, kept).sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: '.metrics/mutate/a.edn', text: 'changed' }, { path: '.metrics/mutate/new.edn', text: 'new' }]);
  });

  it('judges only what changed against the limit', () => {
    const repo = folder(), large = [{ path: 'keep/large', text: 'x'.repeat(900 * 1024) }];
    restoreKept(repo, ['keep'], large);
    writeFileSync(join(repo, 'keep/more'), 'y'.repeat(900 * 1024));
    expect(collectKept(repo, ['keep'], me, large).map(file => file.path)).toEqual(['keep/more']);
  });

  it('goes nowhere but under what its suite names', () => {
    const repo = folder();
    restoreKept(repo, ['.metrics/mutate'], [{ path: 'src/index.ts', text: 'planted' }, { path: '.metrics/mutate-more/a', text: 'planted' }]);
    expect(existsSync(join(repo, 'src'))).toBe(false);
    expect(existsSync(join(repo, '.metrics/mutate-more'))).toBe(false);
  });

  it('never follows a link a commit put in its way', () => {
    const repo = folder(), outside = folder();
    symlinkSync(outside, join(repo, '.metrics'));
    restoreKept(repo, ['.metrics/mutate'], kept);
    expect(existsSync(join(outside, 'mutate'))).toBe(false);
    const again = folder(); mkdirSync(join(again, '.metrics/mutate'), { recursive: true }); symlinkSync(join(outside, 'x'), join(again, '.metrics/mutate/a.edn'));
    restoreKept(again, ['.metrics/mutate'], kept);
    expect(existsSync(join(outside, 'x'))).toBe(false);
  });

  it('never reads through a link, whatever a job left', () => {
    const repo = folder(), outside = folder();
    writeFileSync(join(outside, 'secret'), 'secret');
    mkdirSync(join(repo, '.metrics/mutate'), { recursive: true });
    symlinkSync(join(outside, 'secret'), join(repo, '.metrics/mutate/a.edn'));
    symlinkSync(outside, join(repo, '.metrics/mutate/folder'));
    writeFileSync(join(repo, '.metrics/mutate/b.edn'), 'own');
    expect(collectKept(repo, ['.metrics/mutate'], me)).toEqual([{ path: '.metrics/mutate/b.edn', text: 'own' }]);
    const linked = folder(); symlinkSync(outside, join(linked, '.metrics'));
    expect(collectKept(linked, ['.metrics'], me)).toEqual([]);
    mkdirSync(join(outside, 'mutate')); writeFileSync(join(outside, 'mutate/x'), 'secret');
    expect(collectKept(linked, ['.metrics/mutate'], me)).toEqual([]);
  });

  it('leaves out what is not text and what would not fit', () => {
    const repo = folder(); mkdirSync(join(repo, 'keep'));
    writeFileSync(join(repo, 'keep/binary'), Buffer.from([0xff, 0xfe, 0x00]));
    writeFileSync(join(repo, 'keep/text'), 'ok');
    expect(collectKept(repo, ['keep'], me)).toEqual([{ path: 'keep/text', text: 'ok' }]);
    writeFileSync(join(repo, 'keep/large'), 'x'.repeat(2 * 1024 * 1024));
    expect(collectKept(repo, ['keep'], me)).toEqual([]);
  });

  it('has nothing to say where nothing was left', () => {
    expect(collectKept(folder(), ['keep'], me)).toEqual([]);
  });
});
