import type { Ctx } from '../../app.js';
import { fromDatabase, notConfirmed } from '../../db/confirm.js';
import { isLeaseRefused } from '../../db/net.js';
import { listed, nodeSource, touch, withSource } from '../../db/sources.js';
import { ApiError, loggable } from '../../errors.js';
import type { NodeIdentity, NodeTransport, NumberedMessage } from './hub.js';
import { receiveNodeMessage } from './lifecycle.js';

/* The ends of jobs and of test parts commit more than once, and their own guards make a second run safe, so one that is
   listed is handled again: what its first run did not reach still happens. Every other numbered message is skipped once
   it is listed. */
const AGAIN_WHEN_LISTED: ReadonlySet<string> = new Set(['job.done', 'tests.done']);

/* A serialization failure, a deadlock, a lock not available, and a database that cannot take connections. */
const PASSING_CODES = new Set(['40001', '40P01', '55P03', '57P03', '53300']);
/* A connection to the database that failed, in the database's own codes. */
const CONNECTION_CLASS = '08';
/* What a socket says when it cannot reach the other end. Any socket says so, so these count only from the database. */
const SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

const codeOf = (err: object): string => {
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : '';
};

function passes(err: object): boolean {
  if (err instanceof ApiError) return err.status === 503;
  return PASSING_CODES.has(codeOf(err)) || codeOf(err).startsWith(CONNECTION_CLASS);
}

/* Whether a failure is one that will pass, so that the same message sent again may go through: the lease was refused, a
   commit was not confirmed, the database was out of reach, busy or in conflict, or the app said it cannot serve now.
   Drizzle wraps what the driver throws, so the causes count too. A call to another service that fails is none of these:
   sent again it would fail again, and hold back everything the node sent after it. */
export function passing(err: unknown): boolean {
  if (isLeaseRefused(err) || notConfirmed(err)) return true;
  const ofDatabase = fromDatabase(err);
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (passes(e) || (ofDatabase && SOCKET_CODES.has(codeOf(e)))) return true;
  }
  return false;
}

/* Handles a message the node numbered, once. True: the node may forget it, as it was applied now, was applied before,
   or failed for a reason that sending it again would not mend. False: it failed for a reason that will pass, and the
   node sends it again, with everything it sent after it. */
export async function handleNumbered(ctx: Ctx, id: NodeIdentity, stream: string, msg: NumberedMessage, transport: NodeTransport): Promise<boolean> {
  /* A built-in node's messages are named without its machine: each node's stream is its own, so two never share a name,
     and a message applied by a build before, which knew one built-in node, is found again. */
  const base = nodeSource(id.kind === 'builtin' ? 'builtin' : id.nodeId, stream, msg.n);
  try {
    const before = await listed(ctx.db, base);
    if (before && !AGAIN_WHEN_LISTED.has(msg.type)) await touch(ctx.db, before.first);
    else await withSource(base, () => receiveNodeMessage(ctx, id, msg, transport), before?.next);
    return true;
  } catch (err) {
    if (passing(err)) return false;
    ctx.log.error({ error: loggable(err) }, 'A node message failed.');
    return true;
  }
}
