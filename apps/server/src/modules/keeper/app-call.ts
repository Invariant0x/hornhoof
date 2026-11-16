import http from 'node:http';
import type { Target } from '../../net/proxy.js';
import { OWN_VIA, VIA } from '../network/via.js';

const ASK_MS = 10_000;
const STOPPED = 'the keeper stopped';

export type AppAnswer = { status: number; ok: boolean; json(): unknown };

/* The keeper's own request to its app: from the keeper's address, with the header no door lets through. A body goes as
   JSON. Each ask is a connection of its own, closed with its answer, so none is left open for an app that restarts to
   wait on; and it gives up after ten seconds, or as soon as its keeper stops, so an app that hangs never holds the
   keeper. */
export function askApp(app: Target, method: 'GET' | 'POST', path: string, body?: unknown, stop?: AbortSignal): Promise<AppAnswer> {
  return new Promise((resolve, reject) => {
    if (stop?.aborted) return reject(new Error(STOPPED));
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { [VIA]: OWN_VIA, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) };
    let timer: NodeJS.Timeout | undefined;
    const waiting = () => {
      clearTimeout(timer);
      timer = setTimeout(() => out.destroy(new Error('the app did not answer in ten seconds')), ASK_MS);
      timer.unref();
    };
    const out = http.request({ host: app.host, port: app.port, method, path, headers, agent: false }, res => {
      waiting();
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { waiting(); chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, json: () => JSON.parse(Buffer.concat(chunks).toString()) as unknown });
      });
    });
    out.once('socket', socket => {
      if (socket.connecting) socket.once('connect', waiting);
      else waiting();
    });
    const gone = () => out.destroy(new Error(STOPPED));
    stop?.addEventListener('abort', gone, { once: true });
    out.on('close', () => {
      clearTimeout(timer);
      stop?.removeEventListener('abort', gone);
    });
    out.on('error', reject);
    out.end(text);
  });
}

/* The answer as its status and whatever JSON it carried; none for a body that is no JSON. */
export function answerOf(res: AppAnswer): { status: number; body: unknown } {
  try {
    return { status: res.status, body: res.json() };
  } catch {
    return { status: res.status, body: null };
  }
}
