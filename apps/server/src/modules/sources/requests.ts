import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client.js';
import { listed, openSource, outsideSources, recordNow, sources, touch, webSource, type Source } from '../../db/sources.js';
import { ALREADY_DONE, ApiError } from '../../errors.js';

/* The header a page sends with each change, the same on every try of it. Front and the keeper drop every x-hornhoof-
   header that comes in, and this is the name HTTP drafts use. */
export const REQUEST_ID = 'idempotency-key';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    /* The source this request opened, until its answer goes. */
    changeSource: Source | null;
  }
  interface FastifyContextConfig {
    /* The route acts outside the database before it writes a row, so its first step commits before it acts. */
    startsFirst?: boolean;
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
async function sourceOf(db: Db, req: FastifyRequest, id: string): Promise<Source> {
  const base = webSource(id);
  if (await outsideSources(() => listed(db, base))) {
    await touch(db, base);
    throw new ApiError(409, 'conflict', ALREADY_DONE, 'already_done');
  }
  const source = openSource(base);
  if (req.routeOptions.config.startsFirst) await sources.run(source, () => recordNow(db));
  return source;
}

/* A change that comes with a request id is applied once: the rest of the request runs in a source of that id, every
   commit of it lists its step, and the same id sent again is answered, never run. Any other request runs as before, in
   the source it came in. */
export function registerRequestSources(app: FastifyInstance, db: Db): void {
  app.decorateRequest('changeSource', null);
  app.addHook('preHandler', (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    const id = requestId(req);
    if (!id) return done();
    sourceOf(db, req, id).then(source => {
      req.changeSource = source;
      sources.run(source, () => done());
    }, done);
  });
  /* Every answered request passes here, failed or not, so a timer it left behind records nothing. */
  app.addHook('onSend', async req => {
    if (req.changeSource) req.changeSource.open = false;
  });
}
