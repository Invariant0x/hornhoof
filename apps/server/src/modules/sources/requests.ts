import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { listed, openSource, outsideSources, recordNow, sources, touch, webSource, type Source } from '../../db/sources.js';
import { ALREADY_DONE, ApiError } from '../../errors.js';
import { UUID } from '../../net/proxy.js';

/* The header a page sends with each change, the same on every try of it. Front and the keeper drop every x-hornhoof-
   header that comes in, and this is the name HTTP drafts use. */
export const REQUEST_ID = 'idempotency-key';

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    /* The source this request opened, until its answer goes. */
    changeSource: Source | null;
  }
  interface FastifyContextConfig {
    /* The route acts outside the database before it writes a row, so its first step commits before it acts. */
    startsFirst?: boolean;
    /* An authenticated route may return a result that its own committed data proves. */
    replyToRepeat?: (req: FastifyRequest, base: string, reply: FastifyReply) => Promise<boolean>;
  }
}

/* For a route that reaches a node, the updater, the computer access or the relay before it writes a row of its own. */
export const STARTS_FIRST = { config: { startsFirst: true } } as const;

/* A tool call has an id of its own, given by front, and its own record. */
const isToolCall = (req: FastifyRequest): boolean => req.url === '/mcp' || req.url.startsWith('/mcp?') || req.url.startsWith('/mcp/');

function requestId(req: FastifyRequest): string | null {
  if (!CHANGES.has(req.method) || isToolCall(req)) return null;
  const id = String(req.headers[REQUEST_ID] ?? '').toLowerCase();
  return UUID.test(id) ? id : null;
}

/* A page's answer can carry a session cookie, an invite link or an install command, and is shaped by who asks, so none is
   kept: a change already listed answers that it was done, and the person reloads to see it. */
async function sourceOf(db: Db, req: FastifyRequest, id: string, signedIn: SignedIn, reply: FastifyReply): Promise<Source | null> {
  const base = webSource(id);
  const before = await outsideSources(() => listed(db, base));
  if (before) {
    await touch(db, before.first);
    if (await req.routeOptions.config.replyToRepeat?.(req, base, reply)) return null;
    throw new ApiError(409, 'conflict', ALREADY_DONE, 'already_done');
  }
  const source = openSource(base);
  if (req.routeOptions.config.startsFirst) {
    /* This row is written before the route itself looks at who asks, so only someone signed in gets one written:
       a visitor with a fresh id on every request would otherwise fill the table. */
    await signedIn(req);
    await sources.run(source, () => recordNow(db));
  }
  return source;
}

/* Throws for a request of nobody who is signed in. */
type SignedIn = (req: FastifyRequest) => Promise<unknown>;

/* A change that comes with a request id is applied once: the rest of the request runs in a source of that id, every
   commit of it lists its step, and the same id sent again is answered, never run. Any other request runs as before, in
   the source it came in. */
export function registerRequestSources(app: FastifyInstance, db: Db, signedIn: SignedIn = req => requirePerson(req, db)): void {
  app.decorateRequest('changeSource', null);
  app.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const id = requestId(req);
    if (!id) return done();
    sourceOf(db, req, id, signedIn, reply).then(source => {
      if (!source) return;
      req.changeSource = source;
      sources.run(source, () => done());
    }, done);
  });
  /* Every answered request passes here, failed or not, so a timer it left behind records nothing. */
  app.addHook('onSend', async req => {
    if (req.changeSource) req.changeSource.open = false;
  });
}
