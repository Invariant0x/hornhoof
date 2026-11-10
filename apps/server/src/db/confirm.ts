import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { hasCode } from './errors.js';

const NOT_CONFIRMED_TEXT = 'The database could not confirm the commit, so the change may or may not be saved.';
const WARN_AFTER_MS = 2000;
const LIMIT_ENDED_IT = '25P04';
const OUTSIDE_A_REQUEST = 'work outside a request';
/* A session the server ended, and a transaction the limit ended. */
const LOST_CODES = ['57P01', LIMIT_ENDED_IT];
/* What a connection that broke says. Any socket says the same, as when a call to another service breaks, so these count
   as a loss only on an error a watched query of the database threw. */
const BREAK_CODES = ['ECONNRESET', 'EPIPE'];
const brokeUnderQuery = new WeakSet<object>();
/* What pg throws on a dead connection, which is what drizzle's ROLLBACK throws in place of the first error. */
const NOT_QUERYABLE = 'Client has encountered a connection error and is not queryable';
const CONNECTION_ENDED = 'Connection terminated';

const OPENS = /^\s*(begin|start)\b/i;
const COMMITS = /^\s*(commit|end)\b/i;
/* ROLLBACK TO goes back to a savepoint, and the transaction goes on. */
const UNDOES = /^\s*(abort|rollback(?!\s+to\b))\b/i;
/* Only what says it is inside counts as inside. pg-pool hands out a new connection from inside its first ReadyForQuery, before
   pg notes the status that came with it, so its first statement finds none. */
const INSIDE_A_TRANSACTION: (string | null)[] = ['T', 'E'];

/* The server may have saved the change, as a warning at the commit says it did, or it may not have, as when the session ends
   under the commit. Only a look at the data can tell. */
export class NotConfirmed extends Error {
  constructor(cause?: unknown) {
    super(NOT_CONFIRMED_TEXT, { cause });
    this.name = 'NotConfirmed';
  }
}

const saysLost = (message: unknown): boolean => typeof message === 'string' && (message.startsWith(CONNECTION_ENDED) || message === NOT_QUERYABLE);

function isOwnLoss(err: object): boolean {
  return err instanceof NotConfirmed || brokeUnderQuery.has(err) || saysLost((err as { message?: unknown }).message);
}

/* Marks a failure of a query as a connection that broke under it, and passes it on as it is. */
function noteBreak(err: unknown): never {
  const { code } = (err ?? {}) as { code?: unknown };
  if (err && typeof err === 'object' && typeof code === 'string' && BREAK_CODES.includes(code)) brokeUnderQuery.add(err);
  throw err;
}

/* Whether a failed call may still have changed the data. Drizzle wraps what the driver throws, so it looks at the causes too. */
export function notConfirmed(err: unknown): boolean {
  if (LOST_CODES.some(code => hasCode(err, code))) return true;
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (isOwnLoss(e)) return true;
  }
  return false;
}

/* '<METHOD> <route pattern>' of the request running, for the log lines of its transactions. */
export const requestRoute = new AsyncLocalStorage<string>();

type QueryCallback = (err: Error | null, result?: unknown) => void;
type SendQuery = (...args: unknown[]) => unknown;
/* Goes round one query: run sends it, and what this answers or throws is what the caller gets. */
type AroundQuery = (text: string, run: () => Promise<unknown>) => Promise<unknown>;

const isFunction = (value: unknown): value is QueryCallback => typeof value === 'function';
const fieldOf = (config: unknown, field: string): unknown => (typeof config === 'object' && config !== null ? (config as Record<string, unknown>)[field] : undefined);
const isSubmittable = (config: unknown): boolean => isFunction(fieldOf(config, 'submit'));

function textOf(config: unknown): string {
  const text = typeof config === 'string' ? config : fieldOf(config, 'text');
  return typeof text === 'string' ? text : '';
}

/* Every form of pg's query comes down to one that answers a promise, and the callback when the caller gave one. */
function promiseForm(args: unknown[]): { call: unknown[]; callback?: QueryCallback } {
  const [config, second, third] = args;
  if (isFunction(third)) return { call: [config, second], callback: third };
  if (isFunction(second)) return { call: [config], callback: second };
  const carried = fieldOf(config, 'callback');
  return isFunction(carried) ? { call: [{ ...(config as object), callback: undefined }, second], callback: carried } : { call: args };
}

function answerBack(answer: Promise<unknown>, callback: QueryCallback | undefined): unknown {
  if (!callback) return answer;
  answer.then(
    result => callback(null, result),
    (err: Error) => callback(err),
  );
  return undefined;
}

/* A Submittable, such as a cursor, reads its own rows and stays as it is: nothing in the app writes through one. */
function wrapQuery(client: pg.ClientBase, around: AroundQuery): void {
  const send = client.query.bind(client) as SendQuery;
  const wrapped: SendQuery = (...args) => {
    if (isSubmittable(args[0])) return send(...args);
    const { call, callback } = promiseForm(args);
    return answerBack(around(textOf(args[0]), () => Promise.resolve(send(...call)).catch(noteBreak)), callback);
  };
  client.query = wrapped as typeof client.query;
}

function firstTimeOn(done: WeakSet<pg.ClientBase>, client: pg.ClientBase, install: () => void): void {
  if (done.has(client)) return;
  done.add(client);
  install();
}

const closes = (text: string): boolean => COMMITS.test(text) || UNDOES.test(text);
/* A statement outside a transaction runs as a transaction of its own: it commits, and the same limit holds for it. */
const standsAlone = (text: string, status: string | null): boolean => !INSIDE_A_TRANSACTION.includes(status) && !OPENS.test(text) && !closes(text);
const mayCommit = (text: string, status: string | null): boolean => COMMITS.test(text) || standsAlone(text, status);

async function failOnNotice(client: pg.ClientBase, run: () => Promise<unknown>): Promise<unknown> {
  const notices: unknown[] = [];
  const heard = (notice: unknown): void => void notices.push(notice);
  client.on('notice', heard);
  try {
    const result = await run();
    if (notices.length > 0) throw new NotConfirmed(notices[0]);
    return result;
  } finally {
    client.off('notice', heard);
  }
}

const confirmed = new WeakSet<pg.ClientBase>();

/* Every connection that commits sets client_min_messages to warning, so the only notices that arrive are warnings, whatever
   language the server speaks. A warning at a commit means it may not have gone where it should, as when a wait for a copy
   was cancelled. A call that failed keeps its own error. */
export function confirmCommits(client: pg.ClientBase): void {
  firstTimeOn(confirmed, client, () => {
    wrapQuery(client, (text, run) => (mayCommit(text, client.getTransactionStatus()) ? failOnNotice(client, run) : run()));
  });
}

const keeping = new WeakSet<pg.ClientBase>();
const ignore = (): void => {};

/* pg-pool takes its own listener off a client it lends out, and Node ends the process on an error nobody listens to. pg-pool
   still sees the client is dead when it comes back, and the client's next query fails. */
export function keepErrors(client: pg.ClientBase): void {
  firstTimeOn(keeping, client, () => client.on('error', ignore));
}

type OpenTransaction = { at: number; route: string };

/* What is open on one client, and the one line a limit that ended its session gets. */
class TransactionLog {
  private open: OpenTransaction | null = null;
  private limitTold = false;

  constructor(private readonly log: (line: string) => void) {}

  opened(): void {
    this.open = { at: Date.now(), route: requestRoute.getStore() ?? OUTSIDE_A_REQUEST };
  }

  ended(): void {
    if (this.open && this.ranMs(this.open) > WARN_AFTER_MS) this.log(`A transaction of ${this.open.route} ran ${this.ranMs(this.open)} ms.`);
    this.open = null;
  }

  /* The limit ends the session too, so a client hears of it once, though both an error and the next query may say so. */
  failed(err: unknown): void {
    if (this.limitTold || !this.open || !hasCode(err, LIMIT_ENDED_IT)) return;
    this.limitTold = true;
    this.log(`The 5 s limit ended a transaction of ${this.open.route} after ${this.ranMs(this.open)} ms.`);
  }

  private ranMs(open: OpenTransaction): number {
    return Date.now() - open.at;
  }
}

async function timed(transactions: TransactionLog, text: string, status: string | null, run: () => Promise<unknown>): Promise<unknown> {
  const alone = standsAlone(text, status);
  if (OPENS.test(text) || alone) transactions.opened();
  try {
    const result = await run();
    if (closes(text) || alone) transactions.ended();
    return result;
  } catch (err) {
    transactions.failed(err);
    throw err;
  }
}

const timing = new WeakSet<pg.ClientBase>();

/* A transaction of the app that grows shows here before the limit ends it, by the route that ran it. */
export function logTimeouts(client: pg.ClientBase, log: (line: string) => void): void {
  firstTimeOn(timing, client, () => {
    const transactions = new TransactionLog(log);
    client.on('error', err => transactions.failed(err));
    wrapQuery(client, (text, run) => timed(transactions, text, client.getTransactionStatus(), run));
  });
}
