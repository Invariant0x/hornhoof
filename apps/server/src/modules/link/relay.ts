import { isLinkName } from '@hornhoof/protocol/link';
import { z } from 'zod';
import type { Checker } from '../../checker.js';
import { ApiError } from '../../errors.js';

/* How long one call to the relay may take before Hornhoof says it does not answer. */
const WAIT_MS = 10_000;

export type NameCheck = { name: string; free: boolean; reason?: 'taken' | 'reserved' | 'invalid' };

const Check = z.object({ name: z.string(), free: z.boolean(), reason: z.enum(['taken', 'reserved', 'invalid']).optional() });

/* What the relay gives for a new link: its name and an https address that starts with it, the key that removes it,
   and what the tunnel needs. */
const Bound = z
  .object({
    name: z.string().refine(isLinkName),
    url: z.url({ protocol: /^https$/ }).transform(url => url.replace(/\/+$/, '')),
    key: z.string().min(16).max(1000),
    tunnel: z.record(z.string(), z.unknown()),
  })
  .refine(b => new URL(b.url).hostname.startsWith(`${b.name}.`) && new URL(b.url).pathname === '/');
export type Bound = z.infer<typeof Bound>;

const Count = z.number().int().nonnegative();
const SyncRecord = z.object({ state: z.enum(['on', 'off']), copy: z.string().nullable(), epoch: Count, generation: Count, at: Count.nullable() });
export type SyncRecord = z.infer<typeof SyncRecord>;

/* The route answer may grow fields (R2), so extra ones are let through; every field read here must be right. */
const RouteBody = z.object({
  state: z.enum(['held', 'empty']),
  client: z.string().nullable(),
  since: Count,
  generation: Count,
  relayStarted: Count,
  evictionBound: Count,
  sync: SyncRecord,
});
export type Route = ({ known: true } & z.infer<typeof RouteBody>) | { known: false; why: 'unreachable' | 'slow' | 'refused' | 'malformed' };

export type SyncPost = { client: string; generation: number; state: 'on' | 'off'; copy: string | null; epoch: number };
export type SyncFailure =
  | { stored: false; why: 'slow' | 'unreachable' | 'malformed' | 'mismatch' }
  | { stored: false; why: 'not_holder' | 'stale_epoch' | 'refused'; status: number; error: string | null };
export type SyncResult = { stored: true; sync: SyncRecord } | SyncFailure;

/* A relay from before passthrough has no such field, and that reads as not passing through. */
const Health = z.object({ ok: z.literal(true), frps: z.literal(true), relayStarted: Count, passthrough: z.boolean().default(false) });
export type Health = { up: boolean; relayStarted: number | null; passthrough: boolean };
const DOWN: Health = { up: false, relayStarted: null, passthrough: false };

const KeyAnswer = z.object({ key: z.string().min(16).max(1000) });
const VisitorKeyAnswer = z.object({ visitorKey: z.string().min(16).max(1000) });

/* How long a read of the relay's route or sync answer waits when the caller does not say. */
const READ_MS = 2000;

type Reply = { res: Response } | { failed: 'slow' | 'unreachable' };

const unreachable = () => new ApiError(503, 'unavailable', 'hornhoof.org does not answer now. Try again in a few minutes.', 'relay_unreachable');
const invalid = () => new ApiError(400, 'validation', 'A link name takes 1 to 63 lowercase Latin letters, digits and hyphens, with no hyphen at either end.', 'link_invalid');
const busy = () => new ApiError(429, 'too_many', 'hornhoof.org got too many requests from here. Wait a little and try again.');
/* The same, with the wait the relay asked for, when it named one in whole seconds. */
const busyFor = (retryAfter: string | null) =>
  retryAfter && /^\d{1,6}$/.test(retryAfter) ? new ApiError(429, 'too_many', busy().message, undefined, { retryAfterS: Number(retryAfter) }) : busy();

/* The relay's word on a name it refused, as it gives it. */
async function reasonOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  const said = body?.reason ?? body?.error;
  return typeof said === 'string' ? said : typeof (said as { reason?: unknown })?.reason === 'string' ? (said as { reason: string }).reason : '';
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,31}$/;

/* A short error code from a non-200 JSON body, never the bearer key. */
async function errorCodeOf(res: Response, key: string): Promise<string | null> {
  const said = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return typeof said === 'string' && said !== key && ERROR_CODE.test(said) ? said : null;
}

/* The relay's non-200 answer on a sync post, with its status and short error code. */
async function refusedSync(res: Response, key: string): Promise<SyncFailure> {
  const error = await errorCodeOf(res, key);
  const why = res.status === 409 && (error === 'not_holder' || error === 'stale_epoch') ? error : 'refused';
  return { stored: false, why, status: res.status, error };
}

/* The stored record carries the post's own fields and nothing else changed them. */
const echoes = (stored: SyncRecord, post: SyncPost): boolean =>
  stored.state === post.state && stored.copy === post.copy && stored.epoch === post.epoch && stored.generation === post.generation;

/* The relay hands out public links like acme.hornhoof.org and carries their traffic to this server through the
   tunnel. Only the server talks to it: the browser asks Hornhoof, never the relay. */
export class Relay {
  constructor(private readonly base: string) {}

  /* Never throws: a call that got no answer says whether it was too slow or could not connect. */
  private async attempt(method: string, path: string, opts: { body?: object; key?: string }, timeoutMs: number): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    try {
      const res = await fetch(`${this.base}/api/v1${path}`, { method, headers, body: opts.body && JSON.stringify(opts.body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      /* The body is read here, on a clone, so a stall in it counts as slow and a cut as unreachable. */
      await res.clone().text();
      return { res };
    } catch (error) {
      return { failed: (error as Error).name === 'TimeoutError' ? 'slow' : 'unreachable' };
    }
  }

  private async call(method: string, path: string, opts: { body?: object; key?: string } = {}): Promise<Response> {
    const reply = await this.attempt(method, path, opts, WAIT_MS);
    if ('failed' in reply) throw unreachable();
    return reply.res;
  }

  /* Who holds the link's route. Anything but a clean answer reads as unknown, never as empty (R2). */
  async route(name: string, key: string, timeoutMs = READ_MS): Promise<Route> {
    const reply = await this.attempt('GET', `/links/${encodeURIComponent(name)}/route`, { key }, timeoutMs);
    if ('failed' in reply) return { known: false, why: reply.failed };
    if (reply.res.status !== 200) return { known: false, why: 'refused' };
    const body = RouteBody.safeParse(await reply.res.json().catch(() => null));
    return body.success ? { known: true, ...body.data } : { known: false, why: 'malformed' };
  }

  /* Posts the sync record. It counts as stored only when the relay answers with exactly what was posted. */
  async setSync(name: string, key: string, post: SyncPost, timeoutMs = READ_MS): Promise<SyncResult> {
    const reply = await this.attempt('POST', `/links/${encodeURIComponent(name)}/sync`, { key, body: post }, timeoutMs);
    if ('failed' in reply) return { stored: false, why: reply.failed };
    if (reply.res.status !== 200) return refusedSync(reply.res, key);
    const answer = z.object({ sync: SyncRecord }).safeParse(await reply.res.json().catch(() => null));
    if (!answer.success) return { stored: false, why: 'malformed' };
    return echoes(answer.data.sync, post) ? { stored: true, sync: answer.data.sync } : { stored: false, why: 'mismatch' };
  }

  /* Whether frps takes logins, since when the relay runs, and whether it routes by TLS server name. */
  async health(timeoutMs = READ_MS): Promise<Health> {
    const reply = await this.attempt('GET', '/health', {}, timeoutMs);
    if ('failed' in reply || reply.res.status !== 200) return DOWN;
    const body = Health.safeParse(await reply.res.json().catch(() => null));
    return body.success ? { up: true, relayStarted: body.data.relayStarted, passthrough: body.data.passthrough } : DOWN;
  }

  /* A new link key; the old one stops working at once. next: the key to set, 43 base64url characters, so a caller that
     kept it first still knows the key when the answer is lost on the way; without it the relay picks one. */
  async changeKey(name: string, key: string, next?: string): Promise<string> {
    return (await this.secretFrom(`/links/${encodeURIComponent(name)}/key`, key, KeyAnswer, next === undefined ? undefined : { key: next })).key;
  }

  /* A new visitor key for the link, replacing the one before. */
  async visitorKey(name: string, key: string): Promise<string> {
    return (await this.secretFrom(`/links/${encodeURIComponent(name)}/visitor-key`, key, VisitorKeyAnswer)).visitorKey;
  }

  private async secretFrom<T>(path: string, key: string, answer: Checker<T>, body?: object): Promise<T> {
    const res = await this.call('POST', path, { key, body });
    if (res.status === 429) throw busy();
    const parsed = res.ok ? answer.safeParse(await res.json().catch(() => null)) : null;
    if (!parsed?.success) throw unreachable();
    return parsed.data;
  }

  /* A name no link can have is answered here, without asking. */
  async check(name: string): Promise<NameCheck> {
    if (!isLinkName(name)) return { name, free: false, reason: 'invalid' };
    const res = await this.call('GET', `/names/${name}`);
    if (res.status === 429) throw busy();
    const checked = res.ok ? Check.safeParse(await res.json().catch(() => null)) : null;
    if (!checked?.success) throw unreachable();
    return checked.data;
  }

  /* A new link with this name, or with a long random one when none is given. */
  async bind(name?: string): Promise<Bound> {
    if (name !== undefined && !isLinkName(name)) throw invalid();
    const res = await this.call('POST', '/bindings', { body: name === undefined ? {} : { name } });
    if (res.status === 409 || res.status === 400) {
      if ((await reasonOf(res)) === 'reserved') throw new ApiError(400, 'validation', 'This name is kept for hornhoof.org itself. Pick another one.', 'link_reserved');
      if (res.status === 409) throw new ApiError(409, 'conflict', 'This link is taken already. Pick another name.', 'link_taken');
      throw invalid();
    }
    if (res.status === 429) throw busy();
    const bound = res.status === 201 ? Bound.safeParse(await res.json().catch(() => null)) : null;
    if (!bound?.success) throw unreachable();
    return bound.data;
  }

  /* Passes a report on to Hornhoof's developers and gives back what their inbox answered, as the relay passes it back. One
     it does not take is a fault of this build, and one it cannot pass on now is like the relay not answering. */
  async feedback(report: object): Promise<unknown> {
    const res = await this.call('POST', '/feedback', { body: report });
    if (res.status === 202) return res.json().catch(() => null);
    await res.body?.cancel();
    if (res.status === 429) throw busyFor(res.headers.get('retry-after'));
    if (res.status === 400 || res.status === 413) throw new ApiError(400, 'validation', 'hornhoof.org did not take this report. Update Hornhoof and send it again.', 'feedback_refused');
    throw unreachable();
  }

  /* Takes the link away. One the relay no longer knows, or no longer takes this key for, is gone already. */
  async unbind(name: string, key: string): Promise<void> {
    const res = await this.call('DELETE', `/bindings/${encodeURIComponent(name)}`, { key });
    if (res.ok || [401, 403, 404].includes(res.status)) return;
    if (res.status === 429) throw busy();
    throw unreachable();
  }
}
