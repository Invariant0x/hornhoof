import { isLinkName } from '@hornhoof/protocol/link';
import { z } from 'zod';
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

const unreachable = () => new ApiError(503, 'unavailable', 'hornhoof.org does not answer now. Try again in a few minutes.', 'relay_unreachable');
const invalid = () => new ApiError(400, 'validation', 'A link name takes 1 to 63 lowercase Latin letters, digits and hyphens, with no hyphen at either end.', 'link_invalid');
const busy = () => new ApiError(429, 'too_many', 'hornhoof.org got too many requests from here. Wait a little and try again.');

/* The relay's word on a name it refused, as it gives it. */
async function reasonOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  const said = body?.reason ?? body?.error;
  return typeof said === 'string' ? said : typeof (said as { reason?: unknown })?.reason === 'string' ? (said as { reason: string }).reason : '';
}

/* The relay hands out public links like acme.hornhoof.org and carries their traffic to this server through the
   tunnel. Only the server talks to it: the browser asks Hornhoof, never the relay. */
export class Relay {
  constructor(private readonly base: string) {}

  private async call(method: string, path: string, opts: { body?: object; key?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    try {
      return await fetch(`${this.base}/api/v1${path}`, { method, headers, body: opts.body && JSON.stringify(opts.body), redirect: 'error', signal: AbortSignal.timeout(WAIT_MS) });
    } catch {
      throw unreachable();
    }
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
    if (res.status === 409) throw new ApiError(409, 'conflict', 'This link is taken already. Pick another name.', 'link_taken');
    if (res.status === 400) {
      if ((await reasonOf(res)) === 'reserved') throw new ApiError(400, 'validation', 'This name is kept for hornhoof.org itself. Pick another one.', 'link_reserved');
      throw invalid();
    }
    if (res.status === 429) throw busy();
    const bound = res.status === 201 ? Bound.safeParse(await res.json().catch(() => null)) : null;
    if (!bound?.success) throw unreachable();
    return bound.data;
  }

  /* Takes the link away. One the relay no longer knows, or no longer takes this key for, is gone already. */
  async unbind(name: string, key: string): Promise<void> {
    const res = await this.call('DELETE', `/bindings/${encodeURIComponent(name)}`, { key });
    if (res.ok || [401, 403, 404].includes(res.status)) return;
    if (res.status === 429) throw busy();
    throw unreachable();
  }
}
