import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { maintenanceAnswer } from '../src/modules/keeper/doors.js';
import { awayPage, languageOf } from '../src/net/away-page.js';
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

/* A page that reaches nothing outside itself: no address to fetch, no external script, no font, no frame, and a policy that
   lets nothing but its own style and one line of script act. */
function expectSelfContained(body: string): void {
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|@import|url\(/i);
  expect(body).not.toMatch(/\b(?:src|href)=/i);
  expect(body).toContain(`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`);
}

const RU = { accept: 'text/html', 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' };

describe('the page of a hop with no server behind it', () => {
  it('says no connection in one language, shows that it asks again by itself and does, and reaches nothing outside itself', async () => {
    const door = await frontWithNoKeeper();
    const answer = await send(door, { path: '/people', headers: PAGE });
    expect(answer.status).toBe(502);
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(answer.headers['retry-after']).toBe('5');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers.vary).toBe('Accept-Language');
    expect(answer.body).toContain('<html lang="en" dir="ltr">');
    expect(answer.body).toContain('<h1>No connection to the server</h1>');
    expect(answer.body).toContain('This page opens by itself when the server answers.');
    expect(answer.body).toContain('Checking every 5\u00a0s');
    expect(answer.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(answer.body).toContain('Reload page');
    expect(answer.body).toContain('onclick="location.reload()"');
    expect(answer.body).toContain('<meta name="viewport"');
    expect(answer.body).toContain('class="sign"');
    /* One language, not two in a row. */
    expect(answer.body).not.toMatch(/[А-Яа-я]/);
    expectSelfContained(answer.body);
  });

  it('speaks Russian to a browser that asks for it, and only Russian', async () => {
    const door = await frontWithNoKeeper();
    const answer = await send(door, { path: '/', headers: RU });
    expect(answer.status).toBe(502);
    expect(answer.body).toContain('<html lang="ru" dir="ltr">');
    expect(answer.body).toContain('<h1>Нет связи с сервером</h1>');
    expect(answer.body).toContain('Страница откроется сама, когда сервер ответит.');
    expect(answer.body).toContain('Проверяем каждые 5\u00a0с');
    expect(answer.body).toContain('Обновить страницу');
    expect(answer.body).not.toContain('No connection');
    expect(answer.body).not.toContain('Reload page');
    expectSelfContained(answer.body);
  });

  it('says the server is updating, with the same sizes as the other page, while an update installs', () => {
    const answer = maintenanceAnswer(fake(PAGE, '/tasks'));
    expect(answer.status).toBe(503);
    expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(answer.headers['Retry-After']).toBe('10');
    expect(answer.body).toContain('<h1>Server is updating</h1>');
    expect(answer.body).toContain('This takes a few minutes. The page opens by itself.');
    expect(answer.body).toContain('Checking every 10\u00a0s');
    expect(answer.body).toContain('<meta http-equiv="refresh" content="10">');
    expect(answer.body).not.toContain('No connection to the server');
    const ru = maintenanceAnswer(fake(RU, '/tasks'));
    expect(ru.body).toContain('<h1>Сервер обновляется</h1>');
    expect(ru.body).toContain('Это займет несколько минут. Страница откроется сама.');
    /* The one sheet, so the two states cannot differ in size. */
    expect(answer.body.match(/<style>[^]*?<\/style>/)![0]).toBe(awayPage('lost').match(/<style>[^]*?<\/style>/)![0]);
    expectSelfContained(answer.body);
  });

  it('says no connection after a hold that ran out, as a page too', () => {
    const answer = heldAnswer(fake(PAGE, '/'));
    expect(answer.status).toBe(503);
    expect(answer.body).toBe(awayPage('lost', ''));
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
    expect(maintenanceAnswer(fake({}, '/')).body).toBe('Hornhoof is installing an update. Try again in a few minutes.\n');
    /* A visitor who asks for another language the product ships reads it under the English. */
    expect(maintenanceAnswer(fake({ 'accept-language': 'ru-RU,ru;q=0.9' }, '/')).body).toBe('Hornhoof is installing an update. Try again in a few minutes.\nHornhoof ставит обновление. Попробуйте через несколько минут.\n');
    expect(startingAnswer(fake({ 'accept-language': 'ru' }, '/')).body).toContain('Hornhoof запускается.');
    expect(heldAnswer(fake({ 'accept-language': 'de' }, '/', 'POST')).body).not.toMatch(/[А-Яа-я]/);
  });
});

describe('the language of the page', () => {
  it('takes the first language the visitor asks for that Hornhoof ships, by weight, and English otherwise', () => {
    expect(languageOf('ru-RU,ru;q=0.9,en;q=0.8')).toBe('ru');
    expect(languageOf('en-US,en;q=0.9,ru;q=0.8')).toBe('en');
    expect(languageOf('de-DE,de;q=0.9,ru;q=0.5')).toBe('ru');
    expect(languageOf('ru;q=0.4, en;q=0.9')).toBe('en');
    expect(languageOf('ru;q=0, en;q=0.1')).toBe('en');
    expect(languageOf('de, fr;q=0.8')).toBe('en');
    expect(languageOf('*')).toBe('en');
    expect(languageOf('')).toBe('en');
    expect(languageOf(undefined)).toBe('en');
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
