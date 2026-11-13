import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { REFUSED_HEADER, startProxy } from '../src/web-page/proxy.js';

const CREDENTIALS = { username: 'browse', password: 'a-secret-of-this-run' };
const AUTH = `Basic ${Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.password}`).toString('base64')}`;
/* What the names of the internet answer here: no name leaves the test. */
const NAMES: Record<string, string[]> = {
  'shop.example': ['93.184.215.14'],
  'inside.example': ['192.168.0.9'],
  'mixed.example': ['93.184.215.14', '127.0.0.1'],
};
const lookup = async (host: string) => NAMES[host] ?? [];

type Seen = { url: string | undefined; host: string | undefined; proxyAuth: string | undefined };

/* The local stand plays every public site: the proxy's dial sends each vetted public address to it. */
async function stand(answer: (req: IncomingMessage, res: import('node:http').ServerResponse) => void = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('from the stand'); }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, proxyAuth: req.headers['proxy-authorization'] });
    answer(req, res);
  });
  const port = await listenIn(server);
  onTestFinished(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  return { port, seen };
}

async function proxyTo(standPort: number, maxBytes = 1_000_000) {
  const dialed: string[] = [];
  const proxy = await startProxy({
    lookup,
    maxBytes,
    credentials: CREDENTIALS,
    dial: (address, port) => {
      dialed.push(`${address}:${port}`);
      return connect({ host: '127.0.0.1', port: standPort });
    },
    listen: (server: Server) => listenIn(server),
  });
  onTestFinished(() => proxy.close());
  return { proxy, dialed };
}

function viaProxy(port: number, url: string, headers: Record<string, string> = { 'proxy-authorization': AUTH }) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } }, res => {
      const parts: Buffer[] = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function tunnel(port: number, target: string, headers: Record<string, string> = { 'proxy-authorization': AUTH }) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; socket: Socket }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, headers });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }));
    req.on('error', reject);
    req.end();
  });
}

describe('the proxy every page request of hh-browse goes through', () => {
  it('asks for the credentials of its own run before anything else', async () => {
    const site = await stand();
    const { proxy, dialed } = await proxyTo(site.port);
    const plain = await viaProxy(proxy.port, 'http://shop.example/', {});
    expect(plain.status).toBe(407);
    expect(plain.headers['proxy-authenticate']).toMatch(/^Basic /);
    const wrong = await tunnel(proxy.port, 'shop.example:443', { 'proxy-authorization': `Basic ${Buffer.from('browse:guess').toString('base64')}` });
    expect(wrong.status).toBe(407);
    wrong.socket.destroy();
    expect(dialed).toEqual([]);
    expect(site.seen).toEqual([]);
  });

  it('forwards a page of a public name to the address it vetted, without its own credentials, and never follows a redirect itself', async () => {
    const site = await stand((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: 'http://10.0.0.5/admin' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('from the stand');
    });
    const { proxy, dialed } = await proxyTo(site.port);
    const page = await viaProxy(proxy.port, 'http://shop.example/spring?page=2');
    expect([page.status, page.body]).toEqual([200, 'from the stand']);
    const moved = await viaProxy(proxy.port, 'http://shop.example/moved');
    expect([moved.status, moved.headers.location]).toEqual([302, 'http://10.0.0.5/admin']);
    expect(dialed).toEqual(['93.184.215.14:80', '93.184.215.14:80']);
    expect(site.seen).toEqual([
      { url: '/spring?page=2', host: 'shop.example', proxyAuth: undefined },
      { url: '/moved', host: 'shop.example', proxyAuth: undefined },
    ]);
    expect(proxy.refused).toEqual([]);
  });

  it('refuses names that point inside, mixed answers, internal addresses and other schemes, and records each refusal', async () => {
    const site = await stand();
    const { proxy, dialed } = await proxyTo(site.port);
    for (const url of ['http://inside.example/', 'http://mixed.example/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:9000/', 'http://10.0.0.5/admin']) {
      const answer = await viaProxy(proxy.port, url);
      expect(answer.status, url).toBe(403);
      expect(answer.headers[REFUSED_HEADER], url).toBeDefined();
    }
    const other = await viaProxy(proxy.port, 'ftp://shop.example/file');
    expect(other.status).toBe(403);
    expect(proxy.refused.map(r => r.host)).toEqual(['inside.example', 'mixed.example', '169.254.169.254', 'localhost', '10.0.0.5', 'shop.example']);
    expect(proxy.refused.map(r => r.reason)).toEqual([
      expect.stringMatching(/private/), expect.stringMatching(/loopback/), expect.stringMatching(/cloud metadata/), expect.stringMatching(/local name/), expect.stringMatching(/private/), expect.stringMatching(/only http and https/),
    ]);
    expect(dialed).toEqual([]);
    expect(site.seen).toEqual([]);
  });

  it('opens a tunnel only to a vetted public address, and refuses one to a loopback, private or metadata target', async () => {
    const site = await stand();
    const { proxy, dialed } = await proxyTo(site.port);
    const open = await tunnel(proxy.port, 'shop.example:443');
    expect(open.status).toBe(200);
    open.socket.write('GET /through HTTP/1.1\r\nHost: shop.example\r\nConnection: close\r\n\r\n');
    const parts: Buffer[] = [];
    open.socket.on('data', chunk => parts.push(chunk));
    await once(open.socket, 'end');
    expect(Buffer.concat(parts).toString()).toMatch(/^HTTP\/1\.1 200[\s\S]*from the stand$/);
    for (const target of ['[::1]:443', 'localhost:443', 'inside.example:443', '169.254.169.254:80', '[fd00:ec2::254]:80']) {
      const shut = await tunnel(proxy.port, target);
      expect(shut.status, target).toBe(403);
      shut.socket.destroy();
    }
    expect(dialed).toEqual(['93.184.215.14:443']);
    expect(site.seen).toEqual([{ url: '/through', host: 'shop.example', proxyAuth: undefined }]);
    expect(proxy.refused.map(r => r.host)).toEqual(['::1', 'localhost', 'inside.example', '169.254.169.254', 'fd00:ec2::254']);
  });

  it('refuses a request that is not for another site', async () => {
    const site = await stand();
    const { proxy } = await proxyTo(site.port);
    const answer = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: '/', headers: { 'proxy-authorization': AUTH } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(answer).toBe(400);
    expect(site.seen).toEqual([]);
  });

  it('cuts the page off at its size limit and refuses every request after it', async () => {
    const site = await stand((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5000));
    });
    const { proxy } = await proxyTo(site.port, 1000);
    const cut = await viaProxy(proxy.port, 'http://shop.example/big').catch((err: unknown) => err);
    expect(cut instanceof Error || (cut as { body: string }).body.length < 5000).toBe(true);
    expect(proxy.overLimit()).toBe(true);
    expect(proxy.received()).toBeGreaterThan(1000);
    const after = await viaProxy(proxy.port, 'http://shop.example/small');
    expect(after.status).toBe(403);
    expect(proxy.refused.at(-1)).toEqual({ host: 'shop.example', reason: expect.stringMatching(/size limit/) });
  });
});
