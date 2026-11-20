import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { pageBuild } from '../src/web.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { createTestDb, fixture, invitePerson, SETUP, sessionFrom, TEST_SECRET, TUNNEL, viaLink } from './helpers.js';

type Route = { method: string; url: string; websocket: boolean };
type Origin = 'local' | 'link';

const NAMES_THE_COMPANY = ['Acme', 'Ivan', 'ivan@acme.com', 'Maria', 'maria@acme.com', 'Zebra Payments', 'Zebra Settlements'];

/* Every route that answers 2xx without a session today, with the origin it does so from. A new public route fails the
   test until it is listed here, and the lead reads this list in review. */
const EVERYWHERE: Origin[] = ['local', 'link'];
const PUBLIC: Record<string, Origin[]> = {
  'GET /*': EVERYWHERE,
  'HEAD /*': EVERYWHERE,
  'GET /api/health': EVERYWHERE,
  'HEAD /api/health': EVERYWHERE,
  'GET /api/version': ['local'],
  'HEAD /api/version': ['local'],
  /* The hash of the page at /, for a signed-out page to reload itself once the server serves another. */
  'GET /api/build': EVERYWHERE,
  'HEAD /api/build': EVERYWHERE,
  'GET /robots.txt': EVERYWHERE,
  'HEAD /robots.txt': EVERYWHERE,
  'GET /api/setup': EVERYWHERE,
  'HEAD /api/setup': EVERYWHERE,
  'POST /api/auth/logout': EVERYWHERE,
  'GET /install.sh': EVERYWHERE,
  'HEAD /install.sh': EVERYWHERE,
  /* The same installer for Windows: it carries the server's address and nothing of the company. */
  'GET /install.ps1': EVERYWHERE,
  'HEAD /install.ps1': EVERYWHERE,
};

function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hornhoof-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hornhoof</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
  return dir;
}

/* Every id of every table that has an id column: the company is small, and a leak may hide behind any row. */
async function idsOfEveryTable(db: Db): Promise<string[]> {
  const rowsOf = async <T>(query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: T[] }).rows;
  const tables = await rowsOf<{ table_name: string }>(sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'id'`);
  const ids: string[] = [];
  for (const { table_name } of tables) {
    for (const row of await rowsOf<{ id: string | number }>(sql.raw(`select id from "${table_name}"`))) ids.push(String(row.id));
  }
  return [...new Set(ids)];
}

const FIXED_PARAMS: Record<string, string> = { name: 'acme', token: 'x', number: '1', item: '1', index: '1', sequence: '1', channel: 'email', key: 'x', kind: 'x', '*': 'x' };

/* The urls a route is asked at: its parameters are filled by name, `:id` once with each real id, `:teamId` with the one
   real team, so that a department and its sub-unit are asked for as a real pair. */
function urlsOf(url: string, ids: string[], teamId: string): string[] {
  return (/:id\b/.test(url) ? ids : ['']).map(id =>
    url.replace(/:(\w+)|\*/g, (found, param?: string) => {
      const key = param ?? '*';
      const value = key === 'id' ? id : key === 'teamId' ? teamId : FIXED_PARAMS[key];
      if (value === undefined) throw new Error(`Add the parameter "${key}" of ${url} to FIXED_PARAMS.`);
      return value;
    }),
  );
}

describe('urlsOf', () => {
  it('asks a route with an id once for each id and fills the other parameters by name', () => {
    expect(urlsOf('/api/links/:name/keys/:id', ['a', 'b'], 't')).toEqual(['/api/links/acme/keys/a', '/api/links/acme/keys/b']);
    expect(urlsOf('/*', ['a'], 't')).toEqual(['/x']);
  });

  it('asks a department and its sub-unit as the real pair for every department id', () => {
    expect(urlsOf('/api/departments/:id/teams/:teamId', ['a', 'b'], 't')).toEqual(['/api/departments/a/teams/t', '/api/departments/b/teams/t']);
  });

  it('refuses a parameter it does not know', () => {
    expect(() => urlsOf('/api/things/:mystery', [], 't')).toThrow(/mystery/);
  });
});

/* The company's rows are made once for the file and put back for each test, as making them takes most of a test's setup. */
async function companyWithPeople() {
  const routes: Route[] = [];
  const testDb = await createTestDb();
  const db = testDb as unknown as Db;
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', TUNNEL_HOST: TUNNEL, WEB_DIST: fakeDist() });
  const app = await buildApp({ db, config, onRoute: (r: { method: string | string[]; url: string; websocket?: boolean }) =>
      routes.push(...[r.method].flat().map(method => ({ method, url: r.url, websocket: !!r.websocket }))),
  });
  onTestFinished(() => app.close());
  const { ceoToken, teamId } = await fixture(testDb.$client, 'before sign-in company', async () => {
    const token = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, template: 'startup' } }));
    const [made] = await db.select().from(schema.departments).limit(1);
    const zebra = crypto.randomUUID();
    const team = crypto.randomUUID();
    await db.insert(schema.departments).values({ ...made!, id: zebra, name: 'Zebra Payments' });
    await db.insert(schema.teams).values({ id: team, companyId: made!.companyId, departmentId: zebra, name: 'Zebra Settlements' });
    await invitePerson(app, token, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    return { ceoToken: token, teamId: team };
  });
  return { app, db, routes, ceoToken, teamId };
}

const askFrom = (app: FastifyInstance, route: Route, url: string, origin: Origin) =>
  app.inject({
    method: route.method as 'GET',
    url,
    ...(origin === 'link' ? viaLink() : { remoteAddress: '127.0.0.1' }),
    ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { payload: {} }),
  });

/* Every route is asked from both sides, a route with an id once with each id: twenty thousand questions and more. They
   are shared among the parts by the place of the route in the app, and every part asks every id of its routes. */
const PARTS = 8;

describe('before sign-in', () => {
  it.each(Array.from({ length: PARTS }, (_, part) => part + 1))('answers nothing that names the company before sign-in, locally and over the link, part %i of 8', async part => {
    const { app, db, routes, teamId } = await companyWithPeople();
    await app.ready();
    const ids = await idsOfEveryTable(db);
    expect(ids).toContain(teamId);
    expect(routes.length).toBeGreaterThanOrEqual(30);
    const unlisted: string[] = [];
    for (const route of routes.filter((_, place) => place % PARTS === part - 1)) {
      for (const origin of ['local', 'link'] as const) {
        for (const url of urlsOf(route.url, ids, teamId)) {
          const res = await askFrom(app, route, url, origin);
          const seen = res.body + Object.values(res.headers).join('\n');
          for (const word of NAMES_THE_COMPANY) expect(seen, `${route.method} ${url} ${origin}`).not.toContain(word);
          const listed = PUBLIC[`${route.method} ${route.url}`]?.includes(origin);
          if (res.statusCode < 300 && !listed) unlisted.push(`${route.method} ${route.url} ${origin}`);
        }
      }
    }
    expect([...new Set(unlisted)]).toEqual([]);
  });
});

/* What the upgrade request of a socket carries as the address it came from, the way a real connection does. */
const upgradeFrom = (origin: Origin): Partial<IncomingMessage> => {
  const socket = { remoteAddress: origin === 'link' ? TUNNEL : '127.0.0.1' } as Socket;
  return { socket, headers: origin === 'link' ? viaLink().headers : {} };
};

describe('sockets before sign-in', () => {
  it('refuses every socket route without a session before anything is sent, locally and over the link', async () => {
    const { app, db, routes, teamId } = await companyWithPeople();
    await app.ready();
    const ids = await idsOfEveryTable(db);
    const sockets = routes.filter(r => r.websocket && r.method === 'GET');
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    const opened: string[] = [];
    for (const route of sockets) {
      for (const origin of ['local', 'link'] as const) {
        for (const url of urlsOf(route.url, ids, teamId)) {
          const ws = await app.injectWS(url, upgradeFrom(origin)).catch((err: Error) => err);
          if (ws instanceof Error) {
            expect(ws.message, `${url} ${origin}`).toMatch(/^Unexpected server response: 4\d\d$/);
          } else {
            ws.terminate();
            opened.push(`${url} ${origin}`);
          }
        }
      }
    }
    expect(opened).toEqual([]);
  });
});

describe('what the link tells a stranger', () => {
  it('gives only ok on /api/health over the link', async () => {
    const { app } = await companyWithPeople();
    expect((await app.inject({ url: '/api/health', ...viaLink() })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/api/health', remoteAddress: '127.0.0.1' })).json()).toMatchObject({ ok: true, version: expect.any(String), commit: expect.any(String) });
  });

  it('asks for a session on /api/version over the link', async () => {
    const { app, ceoToken } = await companyWithPeople();
    const stranger = await app.inject({ url: '/api/version', ...viaLink() });
    expect(stranger.statusCode).toBe(401);
    expect(stranger.json().error.reason).toBe('signed_out');
    const signedIn = await app.inject({ url: '/api/version', ...viaLink(ceoToken) });
    expect(signedIn.statusCode).toBe(200);
    expect(Object.keys(signedIn.json()).sort()).toEqual(['commit', 'migrations', 'version']);
    expect((await app.inject({ url: '/api/version', remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
  });

  it('gives a signed-out page only the build of the page at / on /api/build, the same locally and over the link', async () => {
    const { app } = await companyWithPeople();
    const stranger = await app.inject({ url: '/api/build', ...viaLink() });
    const local = await app.inject({ url: '/api/build', remoteAddress: '127.0.0.1' });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.headers['cache-control']).toBe('no-store');
    expect(local.body).toBe(stranger.body);
    /* Nothing but what anyone works out from the page at / alone. */
    const page = await app.inject({ url: '/', ...viaLink() });
    expect(page.statusCode).toBe(200);
    expect(stranger.body).toBe(JSON.stringify({ build: createHash('sha256').update(page.rawPayload).digest('base64url') }));
  });

  it('names a build only for a web app, the same for the same page and another for another', () => {
    const one = fakeDist();
    expect(pageBuild(one)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pageBuild(fakeDist())).toBe(pageBuild(one));
    writeFileSync(join(one, 'index.html'), '<!doctype html><title>Hornhoof</title><div id="root"></div><script src="/assets/app-3c4d.js"></script>');
    expect(pageBuild(one)).not.toBe(pageBuild(fakeDist()));
    expect(pageBuild(mkdtempSync(join(tmpdir(), 'hornhoof-no-web-')))).toBeNull();
  });

  it('asks search engines to stay away', async () => {
    const { app } = await companyWithPeople();
    const robots = await app.inject({ url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(robots.body).toBe('User-agent: *\nDisallow: /\n');
    for (const url of ['/robots.txt', '/api/health', '/api/nope']) {
      expect((await app.inject({ url })).headers['x-robots-tag']).toBe('noindex, nofollow');
    }
  });
});
