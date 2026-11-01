import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { onTestFinished } from 'vitest';

export type FakeRelay = {
  /* The address to give Hornhoof as RELAY_URL. */
  url: string;
  /* The links it handed out, by name, with the key that removes each. */
  bindings: Map<string, { key: string }>;
  reserved: Set<string>;
  /* Every request it got, as "METHOD /path". */
  calls: string[];
  /* While set, it answers 502 to everything, as its proxy does when the service is down. */
  down: boolean;
};

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/* A stand-in for the relay at hornhoof.org, with its API as the relay offers it. */
export async function fakeRelay(): Promise<FakeRelay> {
  const app = Fastify();
  const relay: FakeRelay = { url: '', bindings: new Map(), reserved: new Set(['www', 'api']), calls: [], down: false };
  const check = (name: string) =>
    !NAME.test(name) ? { name, free: false, reason: 'invalid' } : relay.reserved.has(name) ? { name, free: false, reason: 'reserved' } : relay.bindings.has(name) ? { name, free: false, reason: 'taken' } : { name, free: true };

  app.addHook('onRequest', async (req, reply) => {
    relay.calls.push(`${req.method} ${req.url}`);
    if (relay.down) return reply.code(502).send('Bad Gateway');
  });
  app.get<{ Params: { name: string } }>('/api/v1/names/:name', async req => check(req.params.name));
  app.post<{ Body: { name?: string } | undefined }>('/api/v1/bindings', async (req, reply) => {
    const name = req.body?.name ?? randomBytes(12).toString('hex');
    const found = check(name);
    if (!found.free) return reply.code(found.reason === 'taken' ? 409 : 400).send({ error: found.reason });
    const key = randomBytes(24).toString('base64url');
    relay.bindings.set(name, { key });
    return reply.code(201).send({ name, url: `https://${name}.hornhoof.test`, key, tunnel: { server: 'hornhoof.test:7000', token: `tunnel-${name}`, name } });
  });
  app.delete<{ Params: { name: string } }>('/api/v1/bindings/:name', async (req, reply) => {
    const binding = relay.bindings.get(req.params.name);
    if (!binding) return reply.code(404).send({ error: 'unknown' });
    if (req.headers.authorization !== `Bearer ${binding.key}`) return reply.code(403).send({ error: 'forbidden' });
    relay.bindings.delete(req.params.name);
    return reply.code(204).send();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  relay.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(() => app.close());
  return relay;
}
