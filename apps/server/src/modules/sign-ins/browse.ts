import { randomUUID } from 'node:crypto';
import { BrowseLimits, FillAddress, type BrowsedPage, type NodeMessage, type SignedInBrowsed, type SiteSession } from '@hornhoof/protocol';
import { armor, Encrypter } from 'age-encryption';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { jobOf } from '../tools/job.js';
import { sessionFor } from './store.js';

/* hh-browse of an agent opening a page with the sign-in saved for it: Hornhoof finds the agent's sign-in of the page's
   site, seals it to the key of the node the agent's turn runs on, and that node reads the page in a browser of its own
   process. The answer is what the page shows; no cookie goes back to the agent, its tools or its turn. */

/* How long a page may wait on the way to its node before the node refuses to start it. */
const START_MS = 60_000;
/* What the answer may take beyond the call's own limit: the node's start, the browser's start and the answer's way. */
const ANSWER_SPARE_MS = 15_000;

type After = (ms: number) => Promise<void>;
type Pending = { node: string; done(answer: SignedInBrowsed): void };
/* browsers: the key each node seals to, for nodes that said they open pages with a sign-in. */
type State = { browsers: Map<string, string>; pending: Map<string, Pending>; after: After };
const states = new WeakMap<Ctx, State>();
const realAfter: After = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

function stateOf(ctx: Ctx): State {
  let state = states.get(ctx);
  if (!state) states.set(ctx, (state = { browsers: new Map(), pending: new Map(), after: realAfter }));
  return state;
}

/* For tests: how long the call waits for the node. */
export const useBrowseTimer = (ctx: Ctx, after: After) => void (stateOf(ctx).after = after);

/* The node messages of signed-in pages: what a node says it can, in its hello, and its answers. True when done with. */
export function signInNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): boolean {
  const { browsers, pending } = stateOf(ctx);
  if (msg.type === 'hello') {
    if (msg.signedInBrowse && msg.publicKey) browsers.set(keyOf(id), msg.publicKey);
    else browsers.delete(keyOf(id));
    return false;
  }
  if (msg.type !== 'signin.browsed') return false;
  const waiting = pending.get(msg.requestId);
  /* Only the node the page went to answers for it. */
  if (waiting?.node !== keyOf(id)) return true;
  pending.delete(msg.requestId);
  waiting.done(msg);
  return true;
}

export function signInNodeGone(ctx: Ctx, id: NodeIdentity): void {
  if (!ctx.hub.isOnline(id)) stateOf(ctx).browsers.delete(keyOf(id));
}

const Asked = z.strictObject({
  address: FillAddress,
  screenshot: z.boolean().default(false),
  fullPage: z.boolean().default(false),
  waitFor: z.string().min(1).max(500).nullable().default(null),
  limits: BrowseLimits.default({ timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 }),
});
type Asked = z.infer<typeof Asked>;

export type BrowseAnswer =
  | { kind: 'none' }
  | { kind: 'expired'; site: string; savedAt: string }
  | { kind: 'unavailable'; site: string; reason: 'node_offline' | 'unsupported' | 'no_answer' | 'expired' | 'unopened' | 'failed' }
  | { kind: 'browsed'; site: string; page: BrowsedPage; shot?: string };

/* The node the agent's turn runs on: the node of its hh-browse. */
async function nodeOfJob(ctx: Ctx, jobId: string): Promise<NodeIdentity | null> {
  const [row] = await ctx.db
    .select({ nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, kind: subscriptions.kind })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(eq(jobs.id, jobId));
  return row ? identityOf({ kind: row.kind }, row.nodeId, row.builtinMachine, ownBuiltin(ctx.config)) : null;
}

/* A sign-in a browser would send no cookie of any more: each cookie has a date, and every date has passed. */
export function allExpired(session: SiteSession, nowMs: number): boolean {
  return session.cookies.length > 0 && session.cookies.every(c => c.expires > 0 && c.expires * 1000 <= nowMs);
}

async function sealFor(recipient: string, plain: string): Promise<string> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return armor.encode(await e.encrypt(plain));
}

async function browseWithSignIn(ctx: Ctx, job: { id: string; agentId: string }, asked: Asked): Promise<BrowseAnswer> {
  const found = await sessionFor(ctx, job.agentId, asked.address);
  if (!found) return { kind: 'none' };
  const site = found.row.site;
  if (allExpired(found.session, Date.now())) return { kind: 'expired', site, savedAt: found.row.savedAt.toISOString() };
  const unavailable = (reason: Extract<BrowseAnswer, { kind: 'unavailable' }>['reason']): BrowseAnswer => ({ kind: 'unavailable', site, reason });
  const node = await nodeOfJob(ctx, job.id);
  if (!node || !ctx.hub.isOnline(node)) return unavailable('node_offline');
  const state = stateOf(ctx);
  const publicKey = state.browsers.get(keyOf(node));
  if (!publicKey) return unavailable('unsupported');
  const requestId = randomUUID();
  const answered = new Promise<SignedInBrowsed>(done => state.pending.set(requestId, { node: keyOf(node), done }));
  const sent = ctx.hub.send(node, {
    type: 'signin.browse', requestId, jobId: job.id,
    sealed: await sealFor(publicKey, JSON.stringify({ session: found.session, userAgent: found.row.userAgent })),
    address: asked.address, fullPage: asked.fullPage, waitFor: asked.waitFor, screenshot: asked.screenshot, limits: asked.limits,
    expiresAt: new Date(Date.now() + START_MS).toISOString(),
  });
  if (!sent) {
    state.pending.delete(requestId);
    return unavailable('node_offline');
  }
  const answer = await Promise.race([answered, state.after(asked.limits.timeoutMs + ANSWER_SPARE_MS).then(() => null)]);
  state.pending.delete(requestId);
  if (!answer) return unavailable('no_answer');
  if (!answer.page) return unavailable(answer.failure ?? 'failed');
  return { kind: 'browsed', site, page: answer.page, ...(answer.shot ? { shot: answer.shot } : {}) };
}

const invalid = () => new ApiError(400, 'validation', 'hh-browse opens a sign-in only for an http or https address, within its limits.', 'browse_invalid');

export function signInBrowseRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/attachments/browse', async req => {
    const job = await jobOf(ctx, req);
    const asked = Asked.safeParse(req.body ?? {});
    if (!asked.success) throw invalid();
    return browseWithSignIn(ctx, job, asked.data);
  });
}
