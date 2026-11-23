import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { maintenanceAnswer } from '../src/modules/keeper/doors.js';
import { awayPage } from '../src/net/away-page.js';
import { startFront } from '../src/net/front.js';
import { heldAnswer, passThrough, serve, startingAnswer, type Refusal, type Target } from '../src/net/proxy.js';

/* A hop with no server behind it must say the server is away, in plain words and never as a missing page (#1938). A browser
   gets a page, a program the JSON it already read, any other client the words; the status is 502 or 503 for all of them,
   so the app knows the server is missing. What a live server says is missing still passes as 404. */

const PAGE = { accept: 'text/html,application/xhtml+xml' };

async function listening(server: http.Server): Promise<Target> {
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

/* A port nobody listens on, as the keeper's is while it restarts. */
async function nobody(): Promise<Target> {
  const server = http.createServer();
  const target = await listening(server);
  await new Promise(resolve => server.close(resolve));
  return target;
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function send(to: Target, options: http.RequestOptions = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = http.request({ ...to, agent: false, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    out.on('error', reject);
    out.end();
  });
}

async function frontWithNoKeeper(): Promise<Target> {
  const server = await startFront({ port: 0, host: '127.0.0.1', keeper: await nobody(), holdMs: 0 });
  return listening(server).catch(() => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }));
}

const fake = (headers: http.IncomingHttpHeaders, url: string, method = 'GET') => ({ headers, url, method }) as http.IncomingMessage;

/* A page that reaches nothing outside itself: no address to fetch, no script, no font, no frame. */
function expectSelfContained(body: string): void {
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|@import|url\(/i);
  expect(body).not.toMatch(/\b(?:src|href)=/i);
  expect(body).toContain(`default-src 'none'`);
}

describe('the page of a hop with no server behind it', () => {
  it('says no connection in English and Russian, asks again by itself, and reaches nothing outside itself', async () => {
    const door = await frontWithNoKeeper();
    const answer = await send(door, { path: '/people', headers: PAGE });
    expect(answer.status).toBe(502);
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(answer.headers['retry-after']).toBe('5');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toContain('No connection to the server');
    expect(answer.body).toContain('Нет связи с сервером');
    expect(answer.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(answer.body).toContain('<meta name="viewport"');
    expectSelfContained(answer.body);
  });

  it('says the server is updating, in both languages, while an update installs', () => {
    const answer = maintenanceAnswer(fake(PAGE, '/tasks'));
    expect(answer.status).toBe(503);
    expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(answer.headers['Retry-After']).toBe('10');
    expect(answer.body).toContain('Server is updating');
    expect(answer.body).toContain('Сервер обновляется');
    expect(answer.body).toContain('<meta http-equiv="refresh" content="10">');
    expect(answer.body).not.toContain('No connection to the server');
    expectSelfContained(answer.body);
  });

  it('says no connection after a hold that ran out, as a page too', () => {
    const answer = heldAnswer(fake(PAGE, '/'));
    expect(answer.status).toBe(503);
    expect(answer.body).toBe(awayPage('lost'));
  });

  it('keeps the JSON for a program and the words for any other client, whatever the status', () => {
    const json = (answer: Refusal) => JSON.parse(answer.body).error as { code: string; reason: string };
    expect(json(startingAnswer(fake({}, '/api/me'))).reason).toBe('starting');
    expect(json(maintenanceAnswer(fake(PAGE, '/api/me'))).reason).toBe('maintenance');
    expect(json(heldAnswer(fake(PAGE, '/mcp', 'POST'))).reason).toBe('starting');
    for (const answer of [startingAnswer(fake({}, '/')), maintenanceAnswer(fake({ accept: '*/*' }, '/')), heldAnswer(fake(PAGE, '/', 'POST'))]) {
      expect(answer.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    }
    expect(startingAnswer(fake({}, '/')).body).toContain('Hornhoof is starting.');
    expect(maintenanceAnswer(fake({}, '/')).body).toContain('Hornhoof ставит обновление.');
  });
});

describe('what a hop says is never a missing page', () => {
  it('answers 502 or 503 to every kind of request while no server is behind it, and 404 to none', async () => {
    const door = await frontWithNoKeeper();
    const asked: [string, string, http.OutgoingHttpHeaders][] = [
      ['GET', '/', PAGE], ['GET', '/people', PAGE], ['HEAD', '/', PAGE], ['GET', '/assets/app-1a2b.js', {}], ['GET', '/favicon.ico', {}],
      ['GET', '/api/me', {}], ['GET', '/api/stream', { accept: 'text/event-stream' }], ['POST', '/api/tasks', {}], ['GET', '/api/build', {}],
    ];
    for (const [method, path, headers] of asked) {
      const answer = await send(door, { method, path, headers });
      expect([502, 503], `${method} ${path}`).toContain(answer.status);
      expect(answer.headers['retry-after'], `${method} ${path}`).toBeDefined();
    }
  });

  it('still passes on what a live server says is missing: a real 404 stays a 404', async () => {
    const app = await listening(http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }));
    }));
    const keeper = await listening(serve(passThrough({ target: app, headers: () => ({}), unreachable: startingAnswer })));
    const server = await startFront({ port: 0, host: '127.0.0.1', keeper, holdMs: 0 });
    const door = await listening(server).catch(() => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }));
    for (const [path, headers] of [['/api/tasks/nope', {}], ['/nowhere.js', {}], ['/nowhere', PAGE]] as const) {
      const answer = await send(door, { path, headers });
      expect(answer.status, path).toBe(404);
      expect(JSON.parse(answer.body).error.code).toBe('not_found');
    }
  });
});
