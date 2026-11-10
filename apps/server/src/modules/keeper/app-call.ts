import http from 'node:http';
import type { Target } from '../../net/proxy.js';
import { OWN_VIA, VIA } from '../network/via.js';

const ASK_MS = 10_000;

export type AppAnswer = { status: number; ok: boolean; json(): unknown };

/* The keeper's own request to its app: from the keeper's address, with the header no door lets through. A body goes as
   JSON. Each ask is a connection of its own, closed with its answer, so none is left open for an app that restarts to
   wait on; and it gives up after ten seconds, so an app that hangs never holds the keeper. */
export function askApp(app: Target, method: 'GET' | 'POST', path: string, body?: unknown): Promise<AppAnswer> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { [VIA]: OWN_VIA, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) };
    const out = http.request({ host: app.host, port: app.port, method, path, headers, agent: false, timeout: ASK_MS }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, json: () => JSON.parse(Buffer.concat(chunks).toString()) as unknown });
      });
    });
    out.on('timeout', () => out.destroy(new Error('the app did not answer in ten seconds')));
    out.on('error', reject);
    out.end(text);
  });
}
