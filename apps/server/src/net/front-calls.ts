import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { heldAnswer, HOLD, hopHeaders, INVOCATION, socketAddress, type Refusal, type Target } from './proxy.js';

/* For how long front tries a call, counted from when the call came. It leaves the agent's MCP client, which gives up after
   a minute, time to read front's own answer. The keeper holds a request for the app too, so each try tells it how long of
   this is left, and the two holds together stay inside this one. */
const CALL_HOLD_MS = 50_000;
/* The app's own body limit, which /mcp has. */
export const CALL_BODY_MAX = 1024 * 1024;
/* An answer longer than this goes on as it comes, and is not tried again. */
const CALL_ANSWER_MAX = 4 * 1024 * 1024;
export const CALL_LOST = 'Hornhoof did not answer this call in time. It may have run; look at its result before you repeat it.';
export const CALL_NOT_SENT = 'Hornhoof could not be reached in time, so this call did not run. Try it again shortly.';
export const CALL_PAUSED = 'Hornhoof cannot take changes on this machine for a moment, so this call did not run. Try it again in a minute; if it keeps failing, end your turn with what you have done.';
export const CALL_WAITING =
  'Hornhoof is bringing back work from another machine, so this call did not run. Try it again in a few minutes; if it keeps failing, end your turn with what you have done, and it is kept and applied once that machine is back.';

const EVERY_MS = 500;
const JSON_TYPE = { 'Content-Type': 'application/json' };
const TOO_LARGE: Refusal = { status: 413, headers: JSON_TYPE, body: JSON.stringify({ error: { code: 'validation', message: 'Request body is too large' } }) };
const ONE_CALL: Refusal = { status: 400, headers: JSON_TYPE, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Hornhoof takes one call per request.' } }) };

type Options = { keeper: Target; holdMs?: number; everyMs?: number };
/* A whole answer of the keeper, kept to pass on or to try again. */
type Whole = { status: number; raw: string[]; body: Buffer };
/* What one try came to: an answer to pass on as it is, a failure worth another try, or an answer already on its way to
   the agent because it was too long to keep. */
type Tried = { pass: Whole } | { again: Whole | null; reached: boolean } | 'streamed';
type Parsed = { batch: boolean; call: { id: unknown } | null };

function answer(res: http.ServerResponse, { status, headers, body }: Refusal): void {
  res.writeHead(status, { ...headers, 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/* The body, or null once it is longer than the app would take. */
function bodyOf(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= CALL_BODY_MAX) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > CALL_BODY_MAX ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/* A batch cannot be stamped call by call. What is not JSON at all goes on, for the app to answer in its own words. */
function parsed(body: Buffer): Parsed {
  try {
    const said = JSON.parse(body.toString()) as { method?: unknown; id?: unknown } | unknown[] | null;
    if (Array.isArray(said)) return { batch: true, call: null };
    return { batch: false, call: said?.method === 'tools/call' && said.id !== undefined ? { id: said.id } : null };
  } catch {
    return { batch: false, call: null };
  }
}

const reasonOf = ({ body }: Whole): string | undefined => {
  try {
    return (JSON.parse(body.toString()) as { error?: { reason?: string } }).error?.reason;
  } catch {
    return undefined;
  }
};

/* The app says it is starting, or the keeper held the request and the app never came: the call did not reach the app's
   work. Nor did one the app refused because the job's row is still on its way from another machine. */
const waitsForMerge = (answer: Whole): boolean => answer.status === 503 && reasonOf(answer) === 'merge_pending';
/* Or one the app turned away because its machine only reads for a moment, before any tool ran. */
const paused = (answer: Whole): boolean => answer.status === 503 && reasonOf(answer) === 'read_only';
const neverTaken = (answer: Whole): boolean => answer.status === 503 && (reasonOf(answer) === 'starting' || reasonOf(answer) === 'merge_pending' || reasonOf(answer) === 'read_only');

/* Worth another try: that, or a hop before the app had no answer of its own, as when the app dropped the connection. */
const passes = (answer: Whole): boolean => answer.status === 502 || neverTaken(answer) || (answer.status === 503 && reasonOf(answer) === undefined);

/* One try, on a connection of its own. An answer is read whole before anything of it goes to the agent, so one that
   breaks off can be asked for again; one too long to keep goes on as it comes. */
function tryOnce(opts: Options, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, stamp: Record<string, string>): Promise<Tried> {
  return new Promise(resolve => {
    const headers = { ...hopHeaders(req), 'x-forwarded-for': socketAddress(req), 'content-length': String(body.length), ...stamp };
    const out = http.request({ ...opts.keeper, method: 'POST', path: req.url, headers, agent: false });
    let connected = false;
    out.once('socket', socket => socket.once('connect', () => (connected = true)));
    /* A connection that broke after it was made may have carried the call to the app. */
    out.once('error', () => resolve({ again: null, reached: connected }));
    const gone = () => out.destroy();
    res.once('close', gone);
    out.once('close', () => res.off('close', gone));
    out.once('response', up => {
      const chunks: Buffer[] = [];
      let size = 0;
      const whole = (): Whole => ({ status: up.statusCode ?? 502, raw: up.rawHeaders, body: Buffer.concat(chunks) });
      up.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size <= CALL_ANSWER_MAX) return;
        up.removeAllListeners('data').removeAllListeners('end').removeAllListeners('error').removeAllListeners('aborted');
        res.writeHead(up.statusCode ?? 502, up.rawHeaders);
        for (const kept of chunks) res.write(kept);
        up.pipe(res);
        resolve('streamed');
      });
      up.once('error', () => resolve({ again: null, reached: true }));
      up.once('aborted', () => resolve({ again: null, reached: true }));
      up.once('end', () => {
        if (!up.complete) return resolve({ again: null, reached: true });
        const got = whole();
        resolve(passes(got) ? { again: got, reached: !neverTaken(got) } : { pass: got });
      });
    });
    out.end(body);
  });
}

const END_HERE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

function passOn(res: http.ServerResponse, { status, raw, body }: Whole): void {
  const headers: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (!END_HERE.has(raw[i]!.toLowerCase())) headers.push(raw[i]!, raw[i + 1]!);
  res.writeHead(status, [...headers, 'Content-Length', String(body.length)]);
  res.end(body);
}

/* What the agent hears of a call front gave up: a tool's own error, which says whether the call may have run. */
function gaveUp(id: unknown, mayHaveRun: boolean, last: Whole | null): Refusal {
  const text = mayHaveRun ? CALL_LOST : last && waitsForMerge(last) ? CALL_WAITING : last && paused(last) ? CALL_PAUSED : CALL_NOT_SENT;
  return { status: 200, headers: JSON_TYPE, body: JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }) };
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function carry(opts: Options, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await bodyOf(req);
  if (!body) return answer(res, TOO_LARGE);
  const { batch, call } = parsed(body);
  if (batch) return answer(res, ONE_CALL);
  /* The same id on every try of this call, so the app runs it once however many tries it took. */
  const invocation = call ? randomUUID() : null;
  const holdMs = opts.holdMs ?? CALL_HOLD_MS;
  const everyMs = opts.everyMs ?? EVERY_MS;
  const until = Date.now() + holdMs;
  let mayHaveRun = false;
  let last: Whole | null = null;
  while (!res.destroyed) {
    const stamp = { [HOLD]: String(Math.max(0, until - Date.now())), ...(invocation ? { [INVOCATION]: invocation } : {}) };
    const tried = await tryOnce(opts, req, res, body, stamp);
    if (tried === 'streamed' || res.destroyed) return;
    if ('pass' in tried) return passOn(res, tried.pass);
    mayHaveRun ||= tried.reached;
    last = tried.again ?? last;
    if (Date.now() + everyMs > until) break;
    await pause(everyMs);
  }
  if (res.destroyed) return;
  if (call) return answer(res, gaveUp(call.id, mayHaveRun, last));
  if (last) return passOn(res, last);
  answer(res, heldAnswer(req));
}

/* Takes an agent's tool calls, POST /mcp, and answers true; anything else is not its, and it answers false. Each call is
   read whole, stamped with an id of its own, and sent to the keeper again with the same id while the app restarts, so
   the agent sees one answer and the app runs the call once. */
export function frontCalls(opts: Options): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return (req, res) => {
    if (req.method !== 'POST' || String(req.url).split('?')[0] !== '/mcp') return false;
    void carry(opts, req, res).catch(() => res.destroy());
    return true;
  };
}
