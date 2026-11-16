import { BROWSED_SHOT_MAX, SignedInPlain, type BrowsedPage, type SignedInBrowse, type SignedInBrowsed } from '@hornhoof/protocol';
import { redact } from '../redact.js';
import type { BrowseRequest } from './browse.js';
import type { BrowseResult } from './read.js';

/* An agent's hh-browse opening a page with the sign-in saved for it, in a browser of the node's own process: Hornhoof
   sealed the sign-in to this node's key, the node opens it, hides each of its values from everything it says before the
   browser starts, reads the page with it and answers with what the page shows. The agent's process never holds a value. */

/* What the browser is asked: the picture comes back as bytes, not as a file of the node. */
export type NodeBrowse = Omit<BrowseRequest, 'screenshot' | 'signal'> & { screenshot: boolean; signIn: SignedInPlain };

export type SignedInDeps = {
  /* Opens the sealed part with the node's own key; throws when it is not for this node. */
  open(sealed: string): Promise<Uint8Array>;
  /* Hides values from all the node's output from now on. */
  hide(values: string[], untilMs: number): void;
  send(message: SignedInBrowsed): void;
  browse(request: NodeBrowse): Promise<{ result: BrowseResult; shot: Buffer | null }>;
  now(): number;
};

/* Shorter values are words a page shows too, as the vault's sign-ins leave them. */
const HIDDEN_MIN = 8;
const NOT_PAST = 'The sign-in saved for you did not get past the sign-in of this site: it has expired, or the site ended it. A person needs to sign you in again.';
const SHOT_LEFT_OUT = 'The screenshot was too large to send and was left out; --full-page off makes it smaller.';

/* Every value of the sign-in, which no line of the node shows. */
export function signInValues({ session }: SignedInPlain): string[] {
  const values = [...session.cookies.map(c => c.value), ...session.origins.flatMap(o => o.localStorage.map(s => s.value))];
  return [...new Set(values.filter(v => v.length >= HIDDEN_MIN))];
}

async function opened(m: SignedInBrowse, deps: SignedInDeps): Promise<SignedInPlain | null> {
  try {
    const parsed = SignedInPlain.safeParse(JSON.parse(new TextDecoder().decode(await deps.open(m.sealed))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* What hh-browse prints of the page, with every value of the sign-in replaced wherever the page showed it. */
function pageOf({ screenshot: _file, ...result }: BrowseResult, values: string[], notes: string[]): BrowsedPage {
  const clean = (text: string) => redact(text, values);
  const maybe = (text: string | null) => (text === null ? null : clean(text));
  return {
    ...result,
    reason: maybe(result.reason),
    address: clean(result.address),
    finalAddress: maybe(result.finalAddress),
    title: maybe(result.title),
    text: maybe(result.text),
    links: result.links.map(link => ({ text: clean(link.text), url: clean(link.url) })),
    notes: [...result.notes, ...notes].map(clean),
  };
}

export async function openSignedIn(m: SignedInBrowse, deps: SignedInDeps): Promise<void> {
  const fail = (failure: 'expired' | 'unopened' | 'failed') => deps.send({ type: 'signin.browsed', requestId: m.requestId, page: null, failure });
  if (!(Date.parse(m.expiresAt) > deps.now())) return fail('expired');
  const signIn = await opened(m, deps);
  if (!signIn) return fail('unopened');
  const values = signInValues(signIn);
  deps.hide(values, Number.POSITIVE_INFINITY);
  let read: { result: BrowseResult; shot: Buffer | null };
  try {
    read = await deps.browse({ address: m.address, screenshot: m.screenshot, fullPage: m.fullPage, waitFor: m.waitFor, limits: m.limits, signIn });
  } catch {
    return fail('failed');
  }
  const shot = read.shot?.toString('base64');
  const fits = shot !== undefined && shot.length <= BROWSED_SHOT_MAX;
  const notes = [...(read.result.status === 'login_required' ? [NOT_PAST] : []), ...(shot !== undefined && !fits ? [SHOT_LEFT_OUT] : [])];
  deps.send({ type: 'signin.browsed', requestId: m.requestId, page: pageOf(read.result, values, notes), ...(fits ? { shot } : {}) });
}
