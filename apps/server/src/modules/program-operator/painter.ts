import { Worker } from 'node:worker_threads';
import type { ResvgRenderOptions } from '@resvg/resvg-js';

/* The PNG of a screen, or the name of what went wrong while drawing it. */
type PainterAnswer = { png: Uint8Array } | { broken: string };

/* What this file needs of a worker. */
type PainterWorker = {
  on(event: 'message', listener: (answer: PainterAnswer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  postMessage(svg: string): void;
  terminate(): Promise<unknown>;
  unref(): void;
};

/* The densest pane the protocol allows takes resvg about 3 s on an idle machine and about 32 s at a load of 47. This is far
   above that, so that only a worker that hangs reaches it. */
export const PAINTER_DEADLINE_MS = 120_000;

/* resvg reads the SVG, lays out its glyphs and draws them all at once, for seconds on a dense pane: here, in a thread of its own,
   and never in the server's own, which answers everybody meanwhile. The PNG goes back as its own buffer, handed over rather than
   copied. A string and not a file, as a file has another name under vitest, under tsx and in dist. The package goes by its name,
   from where this file is, so what the worker loads can be read here. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { Resvg } = require('node:module').createRequire(workerData.from)('@resvg/resvg-js');
parentPort.on('message', svg => {
  let png;
  try {
    png = new Uint8Array(new Resvg(svg, workerData.options).render().asPng());
  } catch (err) {
    parentPort.postMessage({ broken: String(err && err.name) });
    return;
  }
  parentPort.postMessage({ png }, [png.buffer]);
});
`;

export function startPainterWorker(options: ResvgRenderOptions): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { from: import.meta.url, options },
    /* Drawing needs neither the company's secrets nor the flags or the loaders of the process around it. */
    env: {},
    execArgv: [],
  });
}

/* Why a screen has no picture. It names what went wrong with the drawing, never what the screen showed. */
export class PainterError extends Error {
  constructor(readonly why: string) {
    super(`The screen picture could not be drawn (${why}).`);
    this.name = 'PainterError';
  }
}

type Waiting = { resolve: (png: Uint8Array) => void; reject: (err: PainterError) => void; deadline: NodeJS.Timeout };

/* Draws one screen at a time in one worker, and answers every screen in a bounded time. A worker that fails, stops or runs out of
   time is thrown away, its screen gets a PainterError, and the next screen starts a new one. */
export class ScreenPainter {
  private worker: PainterWorker | undefined;
  private waiting: Waiting | undefined;
  private lastTurn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly startWorker: () => PainterWorker,
    private readonly deadlineMs: number,
  ) {}

  /* A caller waits at most the deadline for each screen ahead of it and one more for its own. */
  paint(svg: string): Promise<Uint8Array> {
    const answer = this.lastTurn.then(() => this.ask(svg));
    this.lastTurn = answer.catch(() => undefined);
    return answer;
  }

  private ask(svg: string): Promise<Uint8Array> {
    let worker: PainterWorker;
    try {
      worker = this.worker ?? this.start();
    } catch {
      return Promise.reject(new PainterError('it could not start'));
    }
    return new Promise((resolve, reject) => {
      /* While a caller waits, this timer is what holds the process open; the worker itself never does. */
      const deadline = setTimeout(() => this.throwAway(worker, 'out of time'), this.deadlineMs);
      this.waiting = { resolve, reject, deadline };
      try {
        worker.postMessage(svg);
      } catch {
        this.throwAway(worker, 'it took no screen');
      }
    });
  }

  private start(): PainterWorker {
    const worker = this.startWorker();
    worker.on('message', answer => this.heard(worker, answer));
    worker.on('error', err => this.throwAway(worker, err.name));
    worker.on('exit', () => this.throwAway(worker, 'it stopped'));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /* A late answer from a worker already thrown away belongs to an earlier screen, and must not pass for the next one's. */
  private heard(worker: PainterWorker, answer: PainterAnswer): void {
    if (worker !== this.worker) return;
    if ('broken' in answer) this.throwAway(worker, answer.broken);
    else this.settle(waiting => waiting.resolve(answer.png));
  }

  private throwAway(worker: PainterWorker, why: string): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    void worker.terminate();
    this.settle(waiting => waiting.reject(new PainterError(why)));
  }

  private settle(answer: (waiting: Waiting) => void): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    clearTimeout(waiting.deadline);
    answer(waiting);
  }
}
