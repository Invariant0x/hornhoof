import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PainterError, ScreenPainter } from '../src/modules/program-operator/painter.js';
import { renderOperatorScreen } from '../src/modules/program-operator/screen.js';
import { pictureType } from '../src/modules/tasks/attachments.js';

/* resvg in this file's own thread refuses to draw: whatever draws a screen here does it in another thread. */
vi.mock('@resvg/resvg-js', async importOriginal => {
  const real = await importOriginal<typeof import('@resvg/resvg-js')>();
  class Resvg {
    constructor() {
      throw new Error('Drawn in the server’s own thread.');
    }
  }
  return { ...real, Resvg };
});

class FakeWorker extends EventEmitter {
  readonly posted: string[] = [];
  terminated = false;
  postMessage(svg: string): void {
    this.posted.push(svg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  unref(): void {}
}

function painterOverFakes(deadlineMs = 60_000): { painter: ScreenPainter; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const start = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  return { painter: new ScreenPainter(start, deadlineMs), workers };
}

/* Lets what is already due run, so that a screen in its turn has reached the worker. */
const aTurnPasses = () => new Promise(resolve => setImmediate(resolve));
const PNG = (byte: number) => ({ png: Uint8Array.of(byte) });

afterEach(() => {
  vi.useRealTimers();
});

describe('drawing a screen', () => {
  it('draws the PNG of a screen outside the server’s own thread', async () => {
    const drawn = await renderOperatorScreen({ cells: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', cols: 40, rows: 4, secrets: [] });
    expect(pictureType(drawn.png)).toBe('image/png');
  });

  it('keeps answering while a worker draws, and takes the PNG once the worker is done', async () => {
    /* The worker draws for as long as the test holds it, so whatever the server's thread does meanwhile, it does while the
       worker draws. */
    const hold = new Int32Array(new SharedArrayBuffer(4));
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', svg => {
        Atomics.wait(workerData.hold, 0, 0);
        parentPort.postMessage({ png: new TextEncoder().encode(svg) });
      });`;
    const painter = new ScreenPainter(() => new Worker(source, { eval: true, workerData: { hold } }), 60_000);
    let done = false;
    const drawing = painter.paint('<svg/>').then(png => { done = true; return png; });
    const timer = await new Promise<string>(resolve => setTimeout(() => resolve('a timer ran'), 0));
    await aTurnPasses();
    expect([timer, done]).toEqual(['a timer ran', false]);
    Atomics.store(hold, 0, 1);
    Atomics.notify(hold, 0);
    expect(new TextDecoder().decode(await drawing)).toBe('<svg/>');
  });

  it('keeps one worker while it draws, one screen at a time', async () => {
    const { painter, workers } = painterOverFakes();
    const first = painter.paint('<svg id="a"/>');
    const second = painter.paint('<svg id="b"/>');
    await aTurnPasses();
    expect(workers[0]!.posted).toEqual(['<svg id="a"/>']);
    workers[0]!.emit('message', PNG(1));
    await expect(first).resolves.toEqual(Uint8Array.of(1));
    await aTurnPasses();
    workers[0]!.emit('message', PNG(2));
    await expect(second).resolves.toEqual(Uint8Array.of(2));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual(['<svg id="a"/>', '<svg id="b"/>']);
  });

  it.each([
    ['says it broke', (w: FakeWorker) => w.emit('message', { broken: 'Error' }), 'Error'],
    ['fails', (w: FakeWorker) => w.emit('error', new RangeError('out of memory')), 'RangeError'],
    ['stops', (w: FakeWorker) => w.emit('exit'), 'it stopped'],
  ])('gives the screen a clear error when its worker %s, and the next screen a new worker', async (_, fail, why) => {
    const { painter, workers } = painterOverFakes();
    const lost = painter.paint('<svg id="a"/>');
    await aTurnPasses();
    fail(workers[0]!);
    await expect(lost).rejects.toThrow(new PainterError(why));
    await expect(lost).rejects.toThrow(`The screen picture could not be drawn (${why}).`);
    expect(workers[0]!.terminated).toBe(true);
    const next = painter.paint('<svg id="b"/>');
    await aTurnPasses();
    workers[1]!.emit('message', PNG(2));
    await expect(next).resolves.toEqual(Uint8Array.of(2));
  });

  it('gives up on a worker that does not answer within its deadline, and ignores what it says later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { painter, workers } = painterOverFakes(1000);
    const lost = painter.paint('<svg id="a"/>');
    void lost.catch(() => undefined);
    await aTurnPasses();
    await vi.advanceTimersByTimeAsync(999);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lost).rejects.toThrow(new PainterError('out of time'));
    expect(workers[0]!.terminated).toBe(true);
    const next = painter.paint('<svg id="b"/>');
    await aTurnPasses();
    workers[0]!.emit('message', PNG(1));
    workers[1]!.emit('message', PNG(2));
    await expect(next).resolves.toEqual(Uint8Array.of(2));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tries again after a worker that could not start', async () => {
    const worker = new FakeWorker();
    const start = vi.fn<() => FakeWorker>().mockImplementationOnce(() => {
      throw new Error('no thread');
    });
    start.mockImplementation(() => worker);
    const painter = new ScreenPainter(start, 60_000);
    await expect(painter.paint('<svg id="a"/>')).rejects.toThrow(new PainterError('it could not start'));
    const next = painter.paint('<svg id="b"/>');
    await aTurnPasses();
    worker.emit('message', PNG(2));
    await expect(next).resolves.toEqual(Uint8Array.of(2));
  });
});
