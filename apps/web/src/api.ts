import { forgetOwnerKey } from './owner-key-store';
/* message: the server's own words, empty when it gave none; the screens word the rest from the dictionaries. */
export class ApiFailure extends Error {
  /* What the server gave with the reason for a screen to show, such as the machines it names. */
  details?: Record<string, unknown>;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

type Said = { code?: string; message?: string; reason?: string; details?: Record<string, unknown> };

/* A failure as the server answered it, with what it said of it; an answer with nothing readable is an internal one. */
function failure(status: number, data: unknown): ApiFailure {
  const said: Said = (data as { error?: Said } | null)?.error ?? {};
  const failed = new ApiFailure(status, said.code ?? 'internal', said.message ?? '', said.reason);
  failed.details = said.details;
  return failed;
}

async function fetchOrigin(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiFailure(0, 'network', '');
  }
}

/* A session the server no longer knows is over on this device too: the person's key goes with it. A wrong password is no
   such end. */
async function failed(status: number, data: unknown): Promise<ApiFailure> {
  const why = failure(status, data);
  if (status === 401 && why.reason === 'signed_out') await forgetOwnerKey();
  return why;
}

/* The answer's JSON, null for an answer with no body, and undefined when the body breaks off before its end. */
async function wholeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/* A read takes its answer whole or not at all. One whose body breaks off, as Firefox stops it when the page reloads
   while it comes, met no server the page can go by: it fails as a read that reached none, never with null for data. */
async function respond<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetchOrigin(path, init);
  if (res.status === 204) return undefined as T;
  const data = await wholeJson(res);
  if (!res.ok) throw await failed(res.status, data ?? null);
  if (data === undefined) throw new ApiFailure(0, 'network', '');
  return data as T;
}

async function respondText(path: string): Promise<string> {
  const res = await fetchOrigin(path);
  if (!res.ok) throw failure(res.status, await res.json().catch(() => null));
  return res.text();
}

const streamErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'stream_error');

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readBodyChunks(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ bytes: Uint8Array; streamError: string | null }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    return { bytes: concatChunks(chunks, total), streamError: null };
  } catch (err) {
    return { bytes: concatChunks(chunks, total), streamError: streamErrorMessage(err) };
  }
}

function parseNonNegativeLength(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function expectedByteLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  return raw ? parseNonNegativeLength(raw) : null;
}

async function readArrayBufferResult(res: Response, expected: number | null) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return finalizeStreamResult(bytes, expected, null);
}

function finalizeStreamResult(bytes: Uint8Array, expected: number | null, streamError: string | null) {
  if (streamError !== null) return { bytes, complete: false, error: streamError };
  if (expected !== null && bytes.byteLength < expected) return { bytes, complete: false, error: 'incomplete' };
  return { bytes, complete: true, error: null };
}

async function respondBytes(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; complete: boolean; error: string | null }> {
  const res = await fetchOrigin(path, signal ? { signal } : {});
  if (!res.ok) throw failure(res.status, await res.json().catch(() => null));
  const expected = expectedByteLength(res);
  if (!res.body) return readArrayBufferResult(res, expected);
  const { bytes, streamError } = await readBodyChunks(res.body.getReader());
  return finalizeStreamResult(bytes, expected, streamError);
}

/* How long a change is tried again after its first failure: a restart of the server, or of the hops before it, ends
   within it. */
export const RETRY_FOR_MS = 60_000;
/* The header the server knows a change by, the same on every try of it. */
const REQUEST_ID = 'idempotency-key';
const WAIT_S = { least: 1, most: 10, unsaid: 2 };

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/* A v4 uuid from getRandomValues: a page opened over plain http has no randomUUID. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/* A try that did not reach an answer the page can go by: the failure to throw when it is the last, and the wait before
   the next. */
type Lost = { lost: ApiFailure; waitMs: number };
type Tried<T> = { value: T } | Lost;

function waitOf(res: Response | null): number {
  const said = Number(res?.headers.get('retry-after') ?? '');
  const seconds = res?.headers.get('retry-after') && Number.isFinite(said) ? Math.min(WAIT_S.most, Math.max(WAIT_S.least, said)) : WAIT_S.unsaid;
  return seconds * 1000;
}

/* The server is starting, or could not confirm the change, or a hop before it answered with no words of the server: the
   request id makes the same change safe to send again. What the server refused in its own words is never sent again. */
function passes(status: number, data: unknown): boolean {
  if (status !== 502 && status !== 503) return false;
  const said = (data as { error?: Said } | null | undefined)?.error;
  return !said || said.reason === 'starting' || said.reason === 'not_confirmed';
}

async function tryChange<T>(path: string, init: RequestInit): Promise<Tried<T>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return { lost: new ApiFailure(0, 'network', ''), waitMs: waitOf(null) };
  }
  if (res.status === 204) return { value: undefined as T };
  const data = await wholeJson(res);
  if (res.ok) return data === undefined ? { lost: new ApiFailure(0, 'network', ''), waitMs: waitOf(res) } : { value: data as T };
  if (passes(res.status, data)) return { lost: failure(res.status, data ?? null), waitMs: waitOf(res) };
  throw failure(res.status, data ?? null);
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/* A change goes with a request id and is sent again with the same id while the server may still take it, so it is
   applied once however many tries it took. */
async function change<T>(path: string, init: RequestInit & { headers: Record<string, string> }): Promise<T> {
  const headers = { ...init.headers, [REQUEST_ID]: newRequestId() };
  let firstLostAt: number | null = null;
  for (;;) {
    const tried = await tryChange<T>(path, { ...init, headers });
    if ('value' in tried) return tried.value;
    firstLostAt ??= Date.now();
    if (Date.now() - firstLostAt + tried.waitMs > RETRY_FOR_MS) throw tried.lost;
    await pause(tried.waitMs);
  }
}

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  return method === 'GET' ? respond<T>(path, init) : change<T>(path, init);
}

export const api = {
  upload: <T>(path: string, file: Blob) => respond<T>(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  /* A file sent whole to a place of its own, as a backup is to a server that is being restored. */
  putFile: <T>(path: string, file: Blob) => respond<T>(path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  text: (path: string) => respondText(path),
  streamBytes: (path: string, signal?: AbortSignal) => respondBytes(path, signal),
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
