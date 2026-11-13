import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { onTestFinished } from 'vitest';
import { listenAt } from '../../../test-support/ports.mjs';

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
  /* The address it gives a new link. */
  urlFor: (name: string) => string;
  /* The reports it took to pass on to Hornhoof's developers, as they came, and how it answers the next one, with the
     body of the inbox's answer, which it passes back unchanged. */
  feedback: unknown[];
  feedbackAnswer: { status: number; headers?: Record<string, string>; body?: unknown };
  /* While set, it passes each report on to this inbox and gives back what the inbox answered, as relay.py does. */
  forward: ((report: unknown) => Promise<{ status: number; body: unknown }>) | null;
};

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/* What the relay gives the tunnel client, as relay.py builds it: the frpc image and config, and its parts. */
const tunnelFor = (name: string, key: string) => ({
  image: 'fatedier/frpc:v0.71.1@sha256:7a0a18bc9c83dc106a7e5213a890f521affdf90d595829c56b0ed8481377d50e',
  configPath: '/etc/frp/frpc.toml',
  args: ['-c', '/etc/frp/frpc.toml'],
  config: `serverAddr = "hornhoof.test"\nmetadatas.name = "${name}"\nmetadatas.key = "${key}"\n`,
  serverAddr: 'hornhoof.test',
  serverPort: 443,
  protocol: 'wss',
  proxyName: name,
  subdomain: name,
  target: 'app:8080',
});

/* A stand-in for the relay at hornhoof.org, with its API as the relay offers it. */
export async function fakeRelay(): Promise<FakeRelay> {
  const app = Fastify();
  const relay: FakeRelay = { url: '', bindings: new Map(), reserved: new Set(['www', 'api']), calls: [], down: false, urlFor: name => `https://${name}.hornhoof.test`, feedback: [], feedbackAnswer: { status: 202 }, forward: null };
  const check = (name: string) =>
    !NAME.test(name) || name.slice(2, 4) === '--' ? { name, free: false, reason: 'invalid' } : relay.reserved.has(name) ? { name, free: false, reason: 'reserved' } : relay.bindings.has(name) ? { name, free: false, reason: 'taken' } : { name, free: true };

  app.addHook('onRequest', async (req, reply) => {
    relay.calls.push(`${req.method} ${req.url}`);
    if (relay.down) return reply.code(502).send('Bad Gateway');
  });
  app.get<{ Params: { name: string } }>('/api/v1/names/:name', async req => check(req.params.name));
  app.post<{ Body: { name?: string } | undefined }>('/api/v1/bindings', async (req, reply) => {
    const name = req.body?.name ?? randomBytes(12).toString('hex');
    const found = check(name);
    if (!found.free) return reply.code(found.reason === 'invalid' ? 400 : 409).send({ error: found.reason, message: `${name} is ${found.reason}.` });
    const key = randomBytes(24).toString('base64url');
    relay.bindings.set(name, { key });
    return reply.code(201).send({ name, url: relay.urlFor(name), key, tunnel: tunnelFor(name, key) });
  });
  app.delete<{ Params: { name: string } }>('/api/v1/bindings/:name', async (req, reply) => {
    const binding = relay.bindings.get(req.params.name);
    if (!binding) return reply.code(404).send({ error: 'unknown' });
    if (req.headers.authorization !== `Bearer ${binding.key}`) return reply.code(401).send({ error: 'unauthorized' });
    relay.bindings.delete(req.params.name);
    return reply.code(204).send();
  });
  app.post('/api/v1/feedback', async (req, reply) => {
    if (relay.forward) {
      relay.feedback.push(req.body);
      const answer = await relay.forward(req.body);
      return reply.code(answer.status).send(answer.body);
    }
    const { status, headers = {}, body = { received: true, number: 1, issue: null } } = relay.feedbackAnswer;
    if (status === 202) relay.feedback.push(req.body);
    return reply.code(status).headers(headers).send(status === 202 ? body : { error: 'refused' });
  });
  await listenAt(port => app.listen({ host: '127.0.0.1', port }));
  relay.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(() => app.close());
  return relay;
}
