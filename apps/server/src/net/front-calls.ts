import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { heldAnswer, hopHeaders, socketAddress, type Refusal, type Target } from './proxy.js';

/* For how long front tries a call again after its first failure. It leaves the agent's MCP client, which gives up after a
   minute, time to read front's own answer. */
export const CALL_HOLD_MS = 50_000;
/* The app's own body limit, which /mcp has. */
export const CALL_BODY_MAX = 1024 * 1024;
/* An answer longer than this goes on as it comes, and is not tried again. */
export const CALL_ANSWER_MAX = 4 * 1024 * 1024;
export const CALL_LOST = 'Hornhoof did not answer this call in time. It may have run; look at its result before you repeat it.';
export const CALL_NOT_SENT = 'Hornhoof could not be reached in time, so this call did not run. Try it again shortly.';

const INVOCATION = 'x-hornhoof-invocation';
const EVERY_MS = 500;
const JSON_TYPE = { 'Content-Type': 'application/json' };
const TOO_LARGE: Refusal = { status: 413, headers: JSON_TYPE, body: JSON.stringify({ error: { code: 'validation', message: 'Request body is too large' } }) };
const ONE_CALL: Refusal = { status: 400, headers: JSON_TYPE, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Hornhoof takes one call per request.' } }) };

type Options = { keeper: Target; holdMs?: number; everyMs?: number };
/* A whole answer of the keeper, kept to pass on or to try again. */
type Whole = { status: number; raw: string[]; body: Buffer };
/* What one try came to: an answer to pass on as it is, a failure worth another try, or an answer already on its way to
   the agent because it was too long to keep. */
type Tried = { pass: Whole } | { again: Whole | null; connected: boolean } | 'streamed';
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

/* The app is starting, or a hop before it had no answer of its own. */
function passes({ status, body }: Whole): boolean {
  if (status === 502) return true;
  if (status !== 503) return false;
  try {
    return (JSON.parse(body.toString()) as { error?: { reason?: string } }).error?.reason === 'starting';
  } catch {
    return true;
  }
}

/* One try, on a connection of its own. An answer is read whole before anything of it goes to the agent, so one that
   breaks off can be asked for again; one too long to keep goes on as it comes. */
function tryOnce(opts: Options, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, invocation: string | null): Promise<Tried> {
  return new Promise(resolve => {
    const headers = { ...hopHeaders(req), 'x-forwarded-for': socketAddress(req), 'content-length': String(body.length), ...(invocation ? { [INVOCATION]: invocation } : {}) };
    const out = http.request({ ...opts.keeper, method: 'POST', path: req.url, headers, agent: false });
    let connected = false;
    out.once('socket', socket => socket.once('connect', () => (connected = true)));
    out.once('error', () => resolve({ again: null, connected }));
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
      up.once('error', () => resolve({ again: null, connected: true }));
      up.once('aborted', () => resolve({ again: null, connected: true }));
      up.once('end', () => {
        if (!up.complete) return resolve({ again: null, connected: true });
        const got = whole();
        resolve(passes(got) ? { again: got, connected: true } : { pass: got });
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
function gaveUp(id: unknown, everConnected: boolean): Refusal {
  const text = everConnected ? CALL_LOST : CALL_NOT_SENT;
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
  let firstFailedAt: number | null = null;
  let everConnected = false;
  let last: Whole | null = null;
  while (!res.destroyed) {
    const tried = await tryOnce(opts, req, res, body, invocation);
    if (tried === 'streamed' || res.destroyed) return;
    if ('pass' in tried) return passOn(res, tried.pass);
    everConnected ||= tried.connected;
    last = tried.again ?? last;
    firstFailedAt ??= Date.now();
    if (Date.now() - firstFailedAt + everyMs > holdMs) break;
    await pause(everyMs);
  }
  if (res.destroyed) return;
  if (call) return answer(res, gaveUp(call.id, everConnected));
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
