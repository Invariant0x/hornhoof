import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { DOWNLOAD_BYTES, DOWNLOAD_EVERY_MS, DOWNLOAD_FIRST_MS, INTERNET_FILE, InternetMeasures } from '../src/modules/keeper/internet.js';
import { selfSigned } from '../src/modules/tls/x509.js';

const MIB = 2 ** 20;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

/* A server on this computer with a certificate made now, which the measures trust by name. */
async function server(handler: Handler) {
  const { certPem, keyPem } = await selfSigned('localhost');
  /* sockets: the connections the requests came on, each by the port of its other end. */
  const state = { sockets: new Set<number | undefined>(), requests: [] as { method: string; url: string; range: string | undefined }[] };
  const made = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    state.requests.push({ method: req.method ?? '', url: req.url ?? '', range: req.headers.range });
    state.sockets.add(req.socket.remotePort);
    handler(req, res);
  });
  await new Promise<void>(resolve => made.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => void made.closeAllConnections());
  onTestFinished(() => void made.close());
  return { url: `https://localhost:${(made.address() as AddressInfo).port}`, ca: certPem, state };
}

function measures(over: { pingUrl?: string; downloadUrl?: string; ca?: string; dir?: string; now?: () => number } = {}) {
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), 'hh-internet-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const made = new InternetMeasures({ dir, log: line => lines.push(line), ...over });
  onTestFinished(() => made.stop());
  return { made, dir, lines };
}

describe("a machine's connection to the internet", () => {
  it('times the second request', async () => {
    /* An answer that says how long its page is: one that does not ends its connection, as Node reads it. */
    const s = await server((_req, res) => void setTimeout(() => res.writeHead(200, { 'content-length': '5' }).end(), 40));
    const m = measures({ pingUrl: `${s.url}/`, ca: s.ca });
    expect(m.made.snapshot()).toEqual({ internetRttMs: null, internetMbps: null });
    await m.made.ping();
    /* Two requests on one connection, so the second holds no handshake. */
    expect(s.state.requests.map(asked => asked.method)).toEqual(['HEAD', 'HEAD']);
    expect(s.state.sockets.size).toBe(1);
    const { internetRttMs } = m.made.snapshot();
    expect(internetRttMs).toBeGreaterThanOrEqual(40);
    expect(internetRttMs).toBeLessThan(1000);
  });

  it('counts any answer as a round trip, and none from a server it does not trust', async () => {
    const refusing = await server((_req, res) => void res.writeHead(403).end());
    const m = measures({ pingUrl: `${refusing.url}/`, ca: refusing.ca });
    await m.made.ping();
    expect(m.made.snapshot().internetRttMs).not.toBeNull();
    /* A certificate signed by someone else, as a captive portal's: no sample, and no failure either. */
    const other = await selfSigned('localhost');
    const stranger = measures({ pingUrl: `${refusing.url}/`, ca: other.certPem });
    await stranger.made.ping();
    expect(stranger.made.snapshot().internetRttMs).toBeNull();
  });

  it('measures a download, and keeps it', async () => {
    const s = await server((req, res) => {
      if (req.url === '/file') return void res.writeHead(302, { location: '/there' }).end();
      /* The whole 4 MiB over four tenths of a second after the headers. */
      res.writeHead(206, { 'content-length': DOWNLOAD_BYTES });
      let sent = 0;
      const step = () => {
        res.write(Buffer.alloc(MIB));
        sent += 1;
        if (sent < 4) setTimeout(step, 100);
        else res.end();
      };
      setTimeout(step, 100);
    });
    const at = Date.parse('2026-11-11T12:00:00Z');
    const m = measures({ downloadUrl: `${s.url}/file`, ca: s.ca, now: () => at });
    await m.made.download();
    expect(s.state.requests.map(asked => [asked.url, asked.range])).toEqual([['/file', 'bytes=0-4194303'], ['/there', 'bytes=0-4194303']]);
    const { internetMbps } = m.made.snapshot();
    /* About 84 Mbit/s on an idle machine; a busy one reads it slower, never faster than the bytes came. */
    expect(internetMbps).toBeGreaterThan(5);
    expect(internetMbps).toBeLessThanOrEqual(120);
    expect(JSON.parse(readFileSync(join(m.dir, INTERNET_FILE), 'utf8'))).toEqual({ mbps: internetMbps, mbpsAt: new Date(at).toISOString(), triedAt: new Date(at).toISOString() });
    /* A keeper that starts again has the rate at once, and tries again a day after the last try. */
    const later = measures({ dir: m.dir, downloadUrl: `${s.url}/file`, ca: s.ca, now: () => at + 2 * 3_600_000 });
    later.made.start();
    expect(later.made.snapshot().internetMbps).toBe(internetMbps);
    expect(later.made.downloadIn()).toBe(DOWNLOAD_EVERY_MS - 2 * 3_600_000);
  });

  it('reads no more than it needs', async () => {
    let closed = false;
    const s = await server((_req, res) => {
      res.writeHead(200);
      res.on('close', () => (closed = true));
      const more = setInterval(() => res.write(Buffer.alloc(MIB)), 5);
      res.on('close', () => clearInterval(more));
    });
    const m = measures({ downloadUrl: `${s.url}/endless`, ca: s.ca });
    await m.made.download();
    expect(m.made.snapshot().internetMbps).toBeGreaterThan(0);
    for (let tries = 0; tries < 100 && !closed; tries++) await pause(20);
    expect(closed).toBe(true);
  });

  it('counts no failed download', async () => {
    let how: 'good' | 'missing' | 'short' | 'loop' = 'good';
    const s = await server((_req, res) => {
      if (how === 'missing') return void res.writeHead(404).end();
      if (how === 'loop') return void res.writeHead(302, { location: '/again' }).end();
      if (how === 'short') {
        res.writeHead(206);
        res.write(Buffer.alloc(MIB / 2));
        return void setTimeout(() => res.destroy(), 20);
      }
      res.writeHead(206);
      res.end(Buffer.alloc(DOWNLOAD_BYTES));
    });
    let now = Date.parse('2026-11-11T12:00:00Z');
    const m = measures({ downloadUrl: `${s.url}/file`, ca: s.ca, now: () => now });
    await m.made.download();
    const good = m.made.snapshot().internetMbps;
    expect(good).not.toBeNull();
    for (const failing of ['missing', 'short', 'loop'] as const) {
      how = failing;
      now += 1000;
      await m.made.download();
      /* The last good rate stays, and the try is still written down, so a failure is not tried again at once. */
      expect(m.made.snapshot().internetMbps, failing).toBe(good);
      expect((JSON.parse(readFileSync(join(m.dir, INTERNET_FILE), 'utf8')) as { triedAt: string }).triedAt, failing).toBe(new Date(now).toISOString());
    }
  });

  it('downloads once a day, and first ten minutes after it started', () => {
    let now = Date.parse('2026-11-11T12:00:00Z');
    const m = measures({ now: () => now });
    m.made.start();
    expect(m.made.downloadIn()).toBe(DOWNLOAD_FIRST_MS);
    now += DOWNLOAD_FIRST_MS;
    expect(m.made.downloadIn()).toBe(0);
  });
});
