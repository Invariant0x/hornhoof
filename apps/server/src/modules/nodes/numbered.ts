import type { Ctx } from '../../app.js';
import { notConfirmed } from '../../db/confirm.js';
import { isLeaseRefused } from '../../db/net.js';
import { listed, nodeSource, touch, withSource } from '../../db/sources.js';
import { ApiError, loggable } from '../../errors.js';
import { keyOf, type NodeIdentity, type NodeTransport, type NumberedMessage } from './hub.js';
import { receiveNodeMessage } from './lifecycle.js';

/* The ends of jobs and of test parts commit more than once, and their own guards make a second run safe, so one that is
   listed is handled again: what its first run did not reach still happens. Every other numbered message is skipped once
   it is listed. */
export const AGAIN_WHEN_LISTED: ReadonlySet<string> = new Set(['job.done', 'tests.done']);

/* A serialization failure, a deadlock, a lock not available, a database that cannot take connections, and a connection
   that failed. */
const PASSING_CODES = new Set(['40001', '40P01', '55P03', '57P03', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
const CONNECTION_CLASS = '08';

function passes(err: object): boolean {
  if (err instanceof ApiError) return err.status === 503;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' && (PASSING_CODES.has(code) || code.startsWith(CONNECTION_CLASS));
}

/* Whether a failure is one that will pass, so that the same message sent again may go through: the lease was refused, a
   commit was not confirmed, the database was out of reach, busy or in conflict, or the app said it cannot serve now.
   Drizzle wraps what the driver throws, so the causes count too. */
export function passing(err: unknown): boolean {
  if (isLeaseRefused(err) || notConfirmed(err)) return true;
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (passes(e)) return true;
  }
  return false;
}

/* Handles a message the node numbered, once. True: the node may forget it, as it was applied now, was applied before,
   or failed for a reason that sending it again would not mend. False: it failed for a reason that will pass, and the
   node sends it again, with everything it sent after it. */
export async function handleNumbered(ctx: Ctx, id: NodeIdentity, stream: string, msg: NumberedMessage, transport: NodeTransport): Promise<boolean> {
  const base = nodeSource(keyOf(id), stream, msg.n);
  try {
    const before = await listed(ctx.db, base);
    if (before && !AGAIN_WHEN_LISTED.has(msg.type)) await touch(ctx.db, base);
    else await withSource(base, () => receiveNodeMessage(ctx, id, msg, transport), before?.next);
    return true;
  } catch (err) {
    if (passing(err)) return false;
    ctx.log.error({ error: loggable(err) }, 'A node message failed.');
    return true;
  }
}
