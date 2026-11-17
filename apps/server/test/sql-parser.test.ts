import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';
import { ThrowawayParser, type ParserAnswer } from '../src/db/sql-parser.js';

class FakeWorker extends EventEmitter {
  readonly posted: string[] = [];
  terminated = false;
  postMessage(text: string): void {
    this.posted.push(text);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  unref(): void {}
}

function parserOverFakes(deadlineMs = 60_000): { parser: ThrowawayParser; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const startWorker = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  return { parser: new ThrowawayParser(startWorker, deadlineMs), workers };
}

/* Lets what is already due run, so that a text in its turn has reached the worker. */
const aTurnPasses = () => new Promise(resolve => setImmediate(resolve));
const TREE: ParserAnswer = { tree: '{}' };

describe('a parser that can be thrown away', () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('keeps one worker while it answers', async () => {
    const { parser, workers } = parserOverFakes();
    const first = parser.parse('a');
    await aTurnPasses();
    workers[0]!.emit('message', TREE);
    await expect(first).resolves.toEqual(TREE);

    const second = parser.parse('b');
    await aTurnPasses();
    workers[0]!.emit('message', { refused: 'syntax error' });
    await expect(second).resolves.toEqual({ refused: 'syntax error' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual(['a', 'b']);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, (worker: FakeWorker) => void]>([
    ['says its parser broke', worker => worker.emit('message', { broken: 'RangeError' })],
    ['throws', worker => worker.emit('error', new RangeError('out of stack'))],
    ['stops', worker => worker.emit('exit', 1)],
  ])('replaces a worker that %s, in one log line', async (_, breakIt) => {
    const { parser, workers } = parserOverFakes();
    const broken = parser.parse('a');
    await aTurnPasses();
    breakIt(workers[0]!);
    await expect(broken).resolves.toEqual({ broken: expect.any(String) });
    expect(workers[0]!.terminated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    const next = parser.parse('b');
    await aTurnPasses();
    workers[1]!.emit('message', TREE);
    await expect(next).resolves.toEqual(TREE);
  });

  it('replaces a worker that never answers, once its time is up', async () => {
    const { parser, workers } = parserOverFakes(1);
    await expect(parser.parse('a')).resolves.toEqual({ broken: expect.any(String) });
    expect(workers[0]!.terminated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /* A late answer belongs to an earlier text, so taking it for the next one would let that one through unread. */
  it('hears nothing more from a worker it threw away', async () => {
    const { parser, workers } = parserOverFakes();
    const broken = parser.parse('a');
    await aTurnPasses();
    workers[0]!.emit('error', new RangeError('out of stack'));
    await broken;

    const next = parser.parse('COMMIT');
    await aTurnPasses();
    workers[0]!.emit('message', { tree: '"a late answer"' });
    workers[0]!.emit('exit', 1);
    workers[1]!.emit('message', TREE);
    await expect(next).resolves.toEqual(TREE);
    expect(workers).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hands over one text at a time', async () => {
    const { parser, workers } = parserOverFakes();
    const first = parser.parse('a');
    const second = parser.parse('b');
    await aTurnPasses();
    expect(workers[0]!.posted).toEqual(['a']);

    workers[0]!.emit('message', TREE);
    await first;
    await aTurnPasses();
    expect(workers[0]!.posted).toEqual(['a', 'b']);
    workers[0]!.emit('message', TREE);
    await second;
  });

  it('charges a broken parser only to the text that broke it', async () => {
    const { parser, workers } = parserOverFakes();
    const breaking = parser.parse('too deep');
    const innocent = parser.parse('SELECT 1');
    await aTurnPasses();
    workers[0]!.emit('message', { broken: 'RangeError' });
    await expect(breaking).resolves.toEqual({ broken: expect.any(String) });

    await aTurnPasses();
    expect(workers[1]!.posted).toEqual(['SELECT 1']);
    workers[1]!.emit('message', TREE);
    await expect(innocent).resolves.toEqual(TREE);
  });

  it('replaces a worker that fails while it waits for work', async () => {
    const { parser, workers } = parserOverFakes();
    const first = parser.parse('a');
    await aTurnPasses();
    workers[0]!.emit('message', TREE);
    await first;

    workers[0]!.emit('error', new Error('out of memory'));
    expect(warn).toHaveBeenCalledTimes(1);
    const next = parser.parse('b');
    await aTurnPasses();
    workers[1]!.emit('message', TREE);
    await expect(next).resolves.toEqual(TREE);
  });

  it('tries again after a worker that could not start', async () => {
    const worker = new FakeWorker();
    const start = vi.fn<() => FakeWorker>().mockImplementationOnce(() => {
      throw new Error('no thread');
    });
    start.mockImplementation(() => worker);
    const parser = new ThrowawayParser(start, 60_000);

    await expect(parser.parse('a')).resolves.toEqual({ broken: expect.any(String) });
    expect(warn).toHaveBeenCalledTimes(1);
    const next = parser.parse('b');
    await aTurnPasses();
    worker.emit('message', TREE);
    await expect(next).resolves.toEqual(TREE);
  });

  /* (module (func (export "spin") (loop (br 0)))), as a parser with broken memory can spin in its own compiled code, where
     no JavaScript around it gets a turn. */
  const SPINS_IN_WASM = `
    const { parentPort } = require('node:worker_threads');
    const code = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115, 112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11]);
    const { spin } = new WebAssembly.Instance(new WebAssembly.Module(code)).exports;
    parentPort.on('message', () => spin());`;

  it('frees a caller from a worker stuck in compiled code, and that worker ends', async () => {
    const stuck = new Worker(SPINS_IN_WASM, { eval: true });
    const ended = once(stuck, 'exit');
    const parser = new ThrowawayParser(() => stuck, 200);
    await expect(parser.parse('anything')).resolves.toEqual({ broken: expect.any(String) });
    await ended;
  });
});

describe('the check as the built server runs it', () => {
  const serverRoot = fileURLToPath(new URL('..', import.meta.url));
  const src = join(serverRoot, 'src');

  /* The probe ends by itself, or the test's own limit ends it: nothing here counts the time it takes. */
  const run = (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(process.execPath, args, { cwd }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
      onTestFinished(() => void child.kill());
    });

  /* The check and every file of the server it imports, as tsc emits each of them into dist: the server builds with
     isolatedModules, so a file comes out the same alone. Written one by one here, no type check is run that the server's
     own build does not run anyway. */
  function build(dir: string): void {
    const waiting = [join(src, 'db/sql-check.ts')];
    const built = new Set<string>();
    for (let file = waiting.pop(); file; file = waiting.pop()) {
      if (built.has(file)) continue;
      built.add(file);
      const out = join(dir, relative(src, file).replace(/\.ts$/, '.js'));
      const source = readFileSync(file, 'utf8');
      const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, outputText);
      for (const { fileName } of ts.preProcessFile(source).importedFiles) {
        if (fileName.startsWith('.')) waiting.push(join(dirname(file), fileName.replace(/\.js$/, '.ts')));
      }
    }
  }

  /* Ends by itself, as the server's process must be free to. A call still waiting must hold the process, or it would die
     on this top level await; an idle parser must not, or it would never end. */
  const PROBE = `
    import { checkAgentSql } from './db/sql-check.js';
    const kindOf = text => checkAgentSql(text).then(() => 'passed', err => err.kind);
    console.log(await kindOf('SELECT 1'));
    console.log(await kindOf('SELECT 1' + '+1'.repeat(1000)));
    console.log(await kindOf('SELECT 1' + '+1'.repeat(6000)));
    console.log(await kindOf('SELECT 1' + '+1'.repeat(9990)));
    console.log(await kindOf('SELECT 1'));
    console.log(await kindOf('COMMIT'));`;

  /* A main stack far past the worker's, and a text that Node's default stack for a worker would take: if the worker's own limit
     were not what decides, the deep texts would pass here. */
  it('starts its worker from dist, and leaves the process free to end', async () => {
    mkdirSync(join(serverRoot, 'dist'), { recursive: true });
    const dir = mkdtempSync(join(serverRoot, 'dist', '.sql-parser-test-'));
    try {
      build(dir);
      writeFileSync(join(dir, 'probe.js'), PROBE);
      const kinds = await run(['--stack-size=3900', 'probe.js'], dir);
      expect(kinds.trim().split('\n')).toEqual(['passed', 'passed', 'syntax', 'syntax', 'passed', 'statement']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
