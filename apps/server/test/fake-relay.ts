import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { onTestFinished } from 'vitest';
import { z } from 'zod';

/* Who holds a name's route, and since when. Unix seconds. The generation counts the registrations let through. */
export type FakeRoute = { state: 'held' | 'empty'; client: string | null; since: number; generation: number };
export type FakeSync = { state: 'on' | 'off'; copy: string | null; epoch: number; generation: number; at: number | null };
type Registered = { ok: true; generation: number } | { ok: false; reason: 'router config conflict' | 'already online' };

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
  routes: Map<string, FakeRoute>;
  syncs: Map<string, FakeSync>;
  visitorKeys: Map<string, string>;
  /* While set, route, sync and health answer 503, and so do the check and the binding of a requested name. */
  frpsDown: boolean;
  relayStarted: number;
  /* True: health says the relay routes by TLS server name (R4.1). */
  passthrough: boolean;
  evictionBound: number;
  /* How the route answer is spoiled: not JSON, one extra field, the state "gone", no answer at all. */
  routeAnswer: 'contract' | 'garbage' | 'extra' | 'badstate' | 'hang';
  /* A registration of a name by a client, as the plugin lets it through or refuses it. */
  register: (name: string, client: string) => Registered;
  /* The holder of a name was evicted or stopped. */
  drop: (name: string) => void;
  /* Every route empty, generations and syncs kept, relayStarted now. */
  restartFrps: () => void;
};

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const newKey = () => randomBytes(24).toString('base64url');
const NO_SYNC: FakeSync = { state: 'off', copy: null, epoch: 0, generation: 0, at: null };
const UNKNOWN = { error: 'unknown', message: 'The relay cannot tell whether the route is live.' };

/* The sync record R2.4 takes: exactly these fields, a copy only when the sync is on. */
const text = z.string().min(1).max(100);
const SyncRecord = z
  .strictObject({ client: text, generation: z.int().min(1), state: z.enum(['on', 'off']), copy: text.nullable(), epoch: z.int().min(1) })
  .refine(record => record.copy !== null || record.state === 'off');
type SyncRecord = z.infer<typeof SyncRecord>;

const holds = (routes: Map<string, FakeRoute>, name: string) => routes.get(name)?.state === 'held';

function register(routes: Map<string, FakeRoute>, name: string, client: string): Registered {
  /* frps meets a live client id at Login, before any registration of a name meets a held route. */
  if ([...routes.values()].some(route => route.state === 'held' && route.client === client)) return { ok: false, reason: 'already online' };
  if (holds(routes, name)) return { ok: false, reason: 'router config conflict' };
  const generation = (routes.get(name)?.generation ?? 0) + 1;
  routes.set(name, { state: 'held', client, since: nowSeconds(), generation });
  return { ok: true, generation };
}

function drop(routes: Map<string, FakeRoute>, name: string): void {
  const route = routes.get(name);
  if (route && holds(routes, name)) routes.set(name, { ...route, state: 'empty', client: null, since: nowSeconds() });
}

/* The record the holder's post sets, or why the relay refuses it. */
function acceptSync(relay: FakeRelay, name: string, record: SyncRecord): FakeSync | 'not_holder' | 'stale_epoch' {
  const route = relay.routes.get(name);
  if (route?.state !== 'held' || route.client !== record.client || route.generation !== record.generation) return 'not_holder';
  if (record.epoch <= (relay.syncs.get(name) ?? NO_SYNC).epoch) return 'stale_epoch';
  const stored: FakeSync = { state: record.state, copy: record.copy, epoch: record.epoch, generation: route.generation, at: nowSeconds() };
  relay.syncs.set(name, stored);
  return stored;
}

/* A binding nobody registered has no route yet. The relay dates it from the binding, which a binding set by a test
   does not record, so its since is 0. */
const NO_ROUTE = { state: 'empty', client: null, since: 0, generation: 0 } as const;

const routeBody = (relay: FakeRelay, name: string) => ({
  ...(relay.routes.get(name) ?? NO_ROUTE),
  relayStarted: relay.relayStarted,
  evictionBound: relay.evictionBound,
  sync: relay.syncs.get(name) ?? NO_SYNC,
});

const spoiled = (mode: FakeRelay['routeAnswer'], body: object): unknown =>
  mode === 'garbage' ? '{not json' : mode === 'extra' ? { ...body, surprise: true } : mode === 'badstate' ? { ...body, state: 'gone' } : body;

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

function newRelay(): FakeRelay {
  const relay: FakeRelay = {
    url: '',
    bindings: new Map(),
    reserved: new Set(['www', 'api']),
    calls: [],
    down: false,
    urlFor: name => `https://${name}.hornhoof.test`,
    routes: new Map(),
    syncs: new Map(),
    visitorKeys: new Map(),
    frpsDown: false,
    relayStarted: nowSeconds(),
    passthrough: true,
    evictionBound: 30,
    routeAnswer: 'contract',
    register: (name, client) => register(relay.routes, name, client),
    drop: name => drop(relay.routes, name),
    restartFrps: () => {
      [...relay.routes.keys()].forEach(name => drop(relay.routes, name));
      relay.relayStarted = nowSeconds();
    },
  };
  return relay;
}

/* What the relay says about a name. */
function nameRules(relay: FakeRelay) {
  /* A reason the relay knows without asking frps. */
  const knownReason = (name: string) =>
    !NAME.test(name) || name.slice(2, 4) === '--' ? 'invalid' : relay.reserved.has(name) ? 'reserved' : relay.bindings.has(name) ? 'taken' : undefined;
  return {
    /* A name with no binding is free only when frps shows no route for it (R1.5). */
    check: (name: string) => {
      const reason = knownReason(name) ?? (holds(relay.routes, name) ? 'taken' : undefined);
      return reason ? { name, free: false, reason } : { name, free: true };
    },
    cannotTell: (name: string) => relay.frpsDown && !knownReason(name),
  };
}

/* A stand-in for the relay at hornhoof.org, with its API as the relay offers it. */
export async function fakeRelay(): Promise<FakeRelay> {
  const app = Fastify({ forceCloseConnections: true });
  const relay = newRelay();
  const { check, cannotTell } = nameRules(relay);
  /* A link call needs its binding and its key: 404 for an unknown name, 401 for a wrong key. */
  const authorize = async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    const binding = relay.bindings.get(req.params.name);
    if (!binding) return reply.code(404).send({ error: 'not_found', message: `There is no binding ${req.params.name}.` });
    if (req.headers.authorization !== `Bearer ${binding.key}`) return reply.code(401).send({ error: 'unauthorized', message: 'Send the binding key as Authorization: Bearer <key>.' });
  };

  app.addHook('onRequest', async (req, reply) => {
    relay.calls.push(`${req.method} ${req.url}`);
    if (relay.down) return reply.code(502).send('Bad Gateway');
  });
  app.get<{ Params: { name: string } }>('/api/v1/names/:name', async (req, reply) => (cannotTell(req.params.name) ? reply.code(503).send(UNKNOWN) : check(req.params.name)));
  app.post<{ Body: { name?: string } | undefined }>('/api/v1/bindings', async (req, reply) => {
    if (req.body?.name !== undefined && cannotTell(req.body.name)) return reply.code(503).send(UNKNOWN);
    const name = req.body?.name ?? randomBytes(12).toString('hex');
    const found = check(name);
    if (!found.free) return reply.code(found.reason === 'invalid' ? 400 : 409).send({ error: found.reason, message: `${name} is ${found.reason}.` });
    const key = newKey();
    relay.bindings.set(name, { key });
    if (!relay.routes.has(name)) relay.routes.set(name, { state: 'empty', client: null, since: nowSeconds(), generation: 0 });
    return reply.code(201).send({ name, url: relay.urlFor(name), key, tunnel: tunnelFor(name, key) });
  });
  app.delete<{ Params: { name: string } }>('/api/v1/bindings/:name', { preHandler: authorize }, async (req, reply) => {
    relay.bindings.delete(req.params.name);
    relay.visitorKeys.delete(req.params.name);
    return reply.code(204).send();
  });
  app.get<{ Params: { name: string } }>('/api/v1/links/:name/route', { preHandler: authorize }, async (req, reply) => {
    if (relay.frpsDown) return reply.code(503).send(UNKNOWN);
    if (relay.routeAnswer === 'hang') return reply.hijack();
    return reply.type('application/json').send(spoiled(relay.routeAnswer, routeBody(relay, req.params.name)));
  });
  app.post<{ Params: { name: string }; Body: unknown }>('/api/v1/links/:name/sync', { preHandler: authorize }, async (req, reply) => {
    const record = SyncRecord.safeParse(req.body);
    if (!record.success) return reply.code(400).send({ error: 'invalid' });
    if (relay.frpsDown) return reply.code(503).send(UNKNOWN);
    const stored = acceptSync(relay, req.params.name, record.data);
    return typeof stored === 'string' ? reply.code(409).send({ error: stored }) : { sync: stored };
  });
  app.post<{ Params: { name: string } }>('/api/v1/links/:name/key', { preHandler: authorize }, async req => {
    const key = newKey();
    relay.bindings.set(req.params.name, { key });
    return { key };
  });
  app.post<{ Params: { name: string } }>('/api/v1/links/:name/visitor-key', { preHandler: authorize }, async req => {
    const visitorKey = newKey();
    relay.visitorKeys.set(req.params.name, visitorKey);
    return { visitorKey };
  });
  app.get('/api/v1/health', async (_req, reply) =>
    relay.frpsDown ? reply.code(503).send({ ok: false, frps: false }) : { ok: true, frps: true, relayStarted: relay.relayStarted, passthrough: relay.passthrough },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  relay.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(() => app.close());
  return relay;
}
