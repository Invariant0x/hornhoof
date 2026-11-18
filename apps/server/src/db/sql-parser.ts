import { Worker } from 'node:worker_threads';

/* The parser's tree as JSON text, what it says is wrong with the text, or why it could not say. The tree crosses as text
   because a structured clone recurses on a deep tree on the receiving side, in the server's main stack, and JSON.parse does not. */
export type ParserAnswer = { tree: string } | { refused: string } | { broken: string };

/* What this file needs of a worker. */
type ParserWorker = {
  on(event: 'message', listener: (answer: ParserAnswer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  postMessage(text: string): void;
  terminate(): Promise<unknown>;
  unref(): void;
};

/* A text the parser reads takes milliseconds. This is far above that, so that only a parser that hangs reaches it, even on a
   machine under load that has to start a new worker first. */
export const PARSER_DEADLINE_MS = 10_000;

/* The stack decides how deep a text the parser takes, so it is set here rather than left to Node's default. With 2 MB a chain
   of about 3,900 operators parses, far past anything written by hand, and the 9,990 that fit in the tool's limit do not. */
const WORKER_STACK_MB = 2;

/* Only SqlError is the parser's verdict on a text. Anything else means the parser itself gave out, and past a stack overflow
   in its compiled code its memory cannot be trusted any more. A name is all that crosses, as a message could quote the text.
   A string and not a file, as a file has another name under vitest, under tsx and in dist, and this runs the same in all three.
   The package goes by its name, from where this file is, so what the worker loads can be read here. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { parse, SqlError } = require('node:module').createRequire(workerData.from)('libpg-query');
const answerTo = async text => {
  try {
    return { tree: JSON.stringify(await parse(text)) };
  } catch (err) {
    return err instanceof SqlError ? { refused: err.message } : { broken: String(err && err.name) };
  }
};
parentPort.on('message', async text => parentPort.postMessage(await answerTo(text)));
`;

export function startParserWorker(): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { from: import.meta.url },
    /* The parser needs neither the company's secrets nor the flags or the loaders of the process around it. */
    env: {},
    execArgv: [],
    resourceLimits: { stackSizeMb: WORKER_STACK_MB },
  });
}

type WaitingCaller = { resolve: (answer: ParserAnswer) => void; deadline: NodeJS.Timeout };

/* Holds the parser in a worker, as one failure can leave its compiled code unusable with no way to load it again inside a
   thread, and answers every text in a bounded time: the worker is thrown away on any failure and on the deadline, and the next
   text starts a new one. It never rejects. */
export class ThrowawayParser {
  private worker: ParserWorker | undefined;
  private waiting: WaitingCaller | undefined;
  private lastTurn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly startWorker: () => ParserWorker,
    private readonly deadlineMs: number,
  ) {}

  /* One text at a time, so that a text that breaks the parser costs only that text. Each turn ends within the deadline, so a
     caller waits at most the deadline for each text ahead of it and one more for its own. */
  parse(text: string): Promise<ParserAnswer> {
    const answer = this.lastTurn.then(() => this.ask(text)).catch(() => this.logged('it could not start'));
    this.lastTurn = answer;
    return answer;
  }

  private ask(text: string): Promise<ParserAnswer> {
    const worker = this.worker ?? this.start();
    return new Promise(resolve => {
      /* While a caller waits, this timer is what holds the process open; the worker itself never does. */
      const deadline = setTimeout(() => this.throwAway(worker, 'out of time'), this.deadlineMs);
      this.waiting = { resolve, deadline };
      worker.postMessage(text);
    });
  }

  private start(): ParserWorker {
    const worker = this.startWorker();
    worker.on('message', answer => this.heard(worker, answer));
    worker.on('error', err => this.throwAway(worker, err.name));
    worker.on('exit', () => this.throwAway(worker, 'it stopped'));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /* A late answer from a worker already thrown away belongs to an earlier text, and must not pass for the next one's. */
  private heard(worker: ParserWorker, answer: ParserAnswer): void {
    if (worker !== this.worker) return;
    if ('broken' in answer) this.throwAway(worker, answer.broken);
    else this.settle(answer);
  }

  private throwAway(worker: ParserWorker, why: string): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    void worker.terminate();
    this.settle(this.logged(why));
  }

  /* This is the only sign that the check lost a parser, and it says nothing of the text. */
  private logged(why: string): ParserAnswer {
    console.warn(`The SQL parser gave out (${why}); the next text gets a new one.`);
    return { broken: why };
  }

  private settle(answer: ParserAnswer): void {
    if (!this.waiting) return;
    clearTimeout(this.waiting.deadline);
    this.waiting.resolve(answer);
    this.waiting = undefined;
  }
}
