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

async function respond<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiFailure(0, 'network', '');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw failure(res.status, data);
  return data as T;
}

const request = <T>(method: string, path: string, body?: unknown) =>
  respond<T>(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  upload: <T>(path: string, file: Blob) => respond<T>(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
