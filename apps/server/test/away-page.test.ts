import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { maintenanceAnswer } from '../src/modules/keeper/doors.js';
import { awayPage } from '../src/net/away-page.js';
import { startFront } from '../src/net/front.js';
import { heldAnswer, passThrough, serve, startingAnswer, type Refusal, type Target } from '../src/net/proxy.js';

/* A hop with no server behind it shows only the Hornhoof logo and one English line, centred on a plain background, and
   refreshes itself so it becomes the app once the server answers (#1938, #2049). A program under /api or /mcp gets JSON;
   a non-read or socket upgrade gets the one English line as plain text. The status stays 502 or 503, never 404. */

const PAGE = { accept: 'text/html,application/xhtml+xml' };
const RU = { accept: 'text/html', 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' };

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

/* A page that reaches nothing outside itself and carries only the logo and one English line. */
function expectLogoAndOneLine(body: string, line: 'No connection' | 'Updating…', refreshS: number): void {
  expect(body).toContain('<html lang="en">');
  expect(body).toContain(`<meta http-equiv="refresh" content="${refreshS}">`);
  expect(body).toContain('<meta name="viewport"');
  expect(body).toContain('class="boot-mark"');
  expect(body).toContain('class="mk-dome"');
  expect(body).toContain('class="mk-base"');
  expect(body).toContain('class="mk-dot"');
  expect(body).toContain('<main class="boot-screen" role="status" aria-busy="true">');
  expect(body).toContain(`<span class="boot-label">${line}</span>`);
  expect(body).toContain('<span class="boot-dots" aria-hidden="true"><i></i><i></i><i></i></span>');
  /* Nothing else: no card, heading, hint, counter, button, script or second language. */
  expect(body).not.toMatch(/<h[1-6]\b|<button\b|onclick=|Checking every|Reload|opens by itself|takes a few minutes|installing an update/i);
  expect(body).not.toMatch(/[А-Яа-яЁё]/);
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|@import|url\(/i);
  expect(body).not.toMatch(/\b(?:src|href)=/i);
  expect(body).toContain(`default-src 'none'; style-src 'unsafe-inline'`);
  expect(body).not.toContain('script-src');
}

describe('the page of a hop with no server behind it', () => {
  it('shows only the logo and "No connection" in English, refreshes itself, and reaches nothing outside itself', async () => {
    const door = await frontWithNoKeeper();
    for (const headers of [PAGE, RU, { accept: '*/*' }, {}]) {
      const answer = await send(door, { path: '/people', headers });
      expect(answer.status).toBe(502);
      expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(answer.headers['retry-after']).toBe('5');
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers.vary).toBeUndefined();
      expectLogoAndOneLine(answer.body, 'No connection', 5);
    }
  });

  it('shows the startup loader and "Updating…" in English while an update installs', () => {
    for (const headers of [PAGE, RU, { accept: '*/*' }, {}]) {
      const answer = maintenanceAnswer(fake(headers, '/tasks'));
      expect(answer.status).toBe(503);
      expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(answer.headers['Retry-After']).toBe('10');
      expect(answer.headers.Vary).toBeUndefined();
      expectLogoAndOneLine(answer.body, 'Updating…', 10);
      expect(answer.body).not.toContain('No connection');
      expect(answer.body.match(/<style>[^]*?<\/style>/)![0]).toBe(awayPage('lost').match(/<style>[^]*?<\/style>/)![0]);
    }
  });

  it('shows the same "No connection" page after a hold that ran out, with or without Accept', () => {
    for (const headers of [PAGE, RU, {}]) {
      const answer = heldAnswer(fake(headers, '/'));
      expect(answer.status).toBe(503);
      expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(answer.body).toBe(awayPage('lost'));
    }
  });

  it('keeps JSON for /api and /mcp, and one English line for non-read or upgrade requests', () => {
    const json = (answer: Refusal) => JSON.parse(answer.body).error as { code: string; reason: string };
    expect(json(startingAnswer(fake({}, '/api/me'))).reason).toBe('starting');
    expect(json(maintenanceAnswer(fake(PAGE, '/api/me'))).reason).toBe('maintenance');
    expect(json(heldAnswer(fake(PAGE, '/mcp', 'POST'))).reason).toBe('starting');

    const postLost = heldAnswer(fake(PAGE, '/', 'POST'));
    const upgradeLost = startingAnswer(fake({ upgrade: 'websocket' }, '/socket'));
    const postUpdating = maintenanceAnswer(fake({}, '/', 'POST'));
    for (const [answer, text] of [[postLost, 'No connection\n'], [upgradeLost, 'No connection\n'], [postUpdating, 'Updating\n']] as const) {
      expect(answer.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(answer.body).toBe(text);
      expect(answer.body).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});

describe('what a hop says is never a missing page', () => {
  it('answers 502 or 503 to every kind of request while no server is behind it, and 404 to none', async () => {
    const door = await frontWithNoKeeper();
    const asked: [string, string, http.OutgoingHttpHeaders][] = [
      ['GET', '/', PAGE], ['GET', '/people', PAGE], ['GET', '/tasks', {}], ['HEAD', '/', PAGE], ['GET', '/assets/app-1a2b.js', {}],
      ['GET', '/favicon.ico', {}], ['GET', '/api/me', {}], ['GET', '/api/stream', { accept: 'text/event-stream' }],
      ['POST', '/api/tasks', {}], ['GET', '/api/build', {}],
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
