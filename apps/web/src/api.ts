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

async function respond<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetchOrigin(path, init);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw failure(res.status, data);
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

function expectedByteLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readArrayBufferResult(res: Response, expected: number | null) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const complete = expected === null || bytes.byteLength >= expected;
  return { bytes, complete, error: complete ? null : 'incomplete' };
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

const request = <T>(method: string, path: string, body?: unknown) =>
  respond<T>(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  upload: <T>(path: string, file: Blob) => respond<T>(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  text: (path: string) => respondText(path),
  streamBytes: (path: string, signal?: AbortSignal) => respondBytes(path, signal),
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
