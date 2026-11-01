import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandling } from '../src/errors.js';

/* A route that throws err, and what the log got of it. */
async function thrown(err: Error) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { level: 'error', stream } });
  registerErrorHandling(app);
  app.get('/boom', async () => {
    throw err;
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return { res, log: lines.join('') };
}

describe('an error no route handled', () => {
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
});
