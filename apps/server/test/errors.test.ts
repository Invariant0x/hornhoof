import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { NotConfirmed, requestRoute } from '../src/db/confirm.js';
import { NOT_CONFIRMED, READ_ONLY_MESSAGE, registerErrorHandling } from '../src/errors.js';

/* A route that throws err, and what the log got of it. */
async function thrown(err: Error, readHistory = false, method: 'GET' | 'POST' = 'GET') {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { level: 'warn', stream } });
  registerErrorHandling(app);
  const path = readHistory ? '/api/agents/:id/events' : '/boom';
  app.route({ method, url: path, handler: async () => {
    throw err;
  } });
  const res = await app.inject({ method, url: readHistory ? '/api/agents/orchestrator/events' : '/boom' });
  await app.close();
  return { res, log: lines.join('') };
}

describe('an error no route handled', () => {
  it('defines errors without a dependency on keeper app mode', () => {
    const source = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/keeper\/app-mode\.js['"]/);
  });

  it('reaches the log without the values of a failed query, the database detail or a password in an address', async () => {
    const cause = Object.assign(new Error('could not connect to postgres://hornhoof:pa55-marker@db:5432/hornhoof'), {
      code: '08006',
      detail: 'Key (email)=(detail-marker@acme.test) already exists.',
    });
    const { res, log } = await thrown(new DrizzleQueryError('select "id" from "people" where "email" = $1', ['param-marker@acme.test'], cause));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
    expect(log).toContain('select \\"id\\" from \\"people\\" where \\"email\\" = $1');
    expect(log).toContain('08006');
    expect(log).toContain('/boom');
    expect(log).toContain('postgres://hornhoof:***@db:5432');
    for (const secret of ['param-marker', 'pa55-marker', 'detail-marker']) expect(log).not.toContain(secret);
  });

  it('keeps what an ordinary error says and where it came from', async () => {
    const { res, log } = await thrown(new Error('The disk is full at /data.'));
    expect(res.statusCode).toBe(500);
    expect(log).toContain('The disk is full at /data.');
    expect(log).toContain('errors.test.ts');
  });

  it('describes a timed-out history read without suggesting a change was submitted', async () => {
    const { res } = await thrown(Object.assign(new Error('transaction timeout'), { code: '25P04' }), true);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('chat_history_unavailable');
  });

  it('returns a read failure on other GET routes when a database transaction times out', async () => {
    const { res } = await thrown(Object.assign(new Error('transaction timeout'), { code: '25P04' }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('read_unavailable');
  });

  it('answers a refused lease as read_only and a lost commit as not_confirmed', async () => {
    const refused = await thrown(new DrizzleQueryError('insert into "tasks"', [], Object.assign(new Error('This machine holds no lease now, so nothing was changed.'), { code: 'HHF01' })));
    expect(refused.res.statusCode).toBe(503);
    expect(refused.res.json()).toEqual({ error: { code: 'unavailable', message: READ_ONLY_MESSAGE, reason: 'read_only' } });

    for (const lost of [new NotConfirmed({ message: 'a warning' }), Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })]) {
      const { res, log } = await thrown(lost, false, 'POST');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: { code: 'unavailable', message: NOT_CONFIRMED, reason: 'not_confirmed' } });
      const [line, ...others] = log.trim().split('\n');
      expect(others).toEqual([]);
      expect(JSON.parse(line!)).toMatchObject({ level: 40, route: '/boom', error: { type: lost.constructor.name, message: lost.message } });
    }
  });
});

describe('the route of a request', () => {
  it('runs each route inside requestRoute', async () => {
    const app = Fastify();
    registerErrorHandling(app);
    app.get('/api/x/:id', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { route: requestRoute.getStore() };
    });
    const res = await app.inject({ method: 'GET', url: '/api/x/1' });
    await app.close();
    expect(res.json()).toEqual({ route: 'GET /api/x/:id' });
  });
});
