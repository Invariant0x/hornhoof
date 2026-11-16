import { randomUUID } from 'node:crypto';
import { sameSite, type FillField, type FillKind, type FillStatus, type FillTarget, type NodeMessage, type SecretFilled, type SiteSession } from '@hornhoof/protocol';
import { armor, Encrypter } from 'age-encryption';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions, vaultLog } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { mayUse, type VaultAgent } from './access.js';
import { entryById, entryByName, notAllowed, plainOf, unknownEntry, type Entry } from './store.js';

/* How Hornhoof has a node type a vault entry: it checks the agent may use the entry, finds the node of the target, seals
   the values to that node's key alone, logs the use, and waits for the node's status. What comes back holds no value. */

/* How long the tool waits for the node, within the minute a program gives a tool call. */
export const FILL_WAIT_MS = 45_000;
/* How long a fill may wait on the way to its node before the node refuses to start it. */
const FILL_START_MS = 60_000;

export type FillAnswerStatus = FillStatus | 'node_offline' | 'no_answer';
export type FillAnswer = { entry: string; target: FillKind; status: FillAnswerStatus; filled: FillField[]; savedSignIn?: boolean; shot?: string };
export type FillRequest = { entry: string; target: FillKind; address?: string; phoneSession?: string; element?: string | null; fields?: FillField[] };

/* What a node said it fills, with the key Hornhoof seals to, while it is connected. */
type Filler = { publicKey: string; fills: FillKind[] };
type Pending = { node: string; done(answer: SecretFilled | null): void };
type After = (ms: number) => Promise<void>;

/* A company phone's node and session generation for this agent, from the phones' own module: it refuses another
   company's session (403) and one the agent does not hold (409). */
export type PhoneTargets = (ctx: Ctx, agent: VaultAgent, phoneSessionId: string) => Promise<{ node: NodeIdentity; generation: number }>;
/* Where a site sign-in the node's browser got goes: the agent's saved sign-ins. True once kept. */
export type SessionStore = (ctx: Ctx, input: { companyId: string; agentId: string; site: string; session: SiteSession }) => Promise<boolean>;

type State = { fillers: Map<string, Filler>; pending: Map<string, Pending>; after: After; phones: PhoneTargets | null; sessions: SessionStore | null };
const states = new WeakMap<Ctx, State>();
const realAfter: After = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

function stateOf(ctx: Ctx): State {
  let state = states.get(ctx);
  if (!state) states.set(ctx, (state = { fillers: new Map(), pending: new Map(), after: realAfter, phones: null, sessions: null }));
  return state;
}

/* For the phones' module, the saved sign-ins' module and tests. */
export const usePhoneTargets = (ctx: Ctx, phones: PhoneTargets) => void (stateOf(ctx).phones = phones);
export const useSessionStore = (ctx: Ctx, sessions: SessionStore) => void (stateOf(ctx).sessions = sessions);
export const useFillTimer = (ctx: Ctx, after: After) => void (stateOf(ctx).after = after);

/* The node messages of filling: what a node fills, in its hello, and its answers. True when the message is done with. */
export function vaultNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): boolean {
  const { fillers, pending } = stateOf(ctx);
  if (msg.type === 'hello') {
    if (msg.publicKey && msg.fills?.length) fillers.set(keyOf(id), { publicKey: msg.publicKey, fills: msg.fills });
    else fillers.delete(keyOf(id));
    return false;
  }
  if (msg.type !== 'secret.filled') return false;
  const waiting = pending.get(msg.requestId);
  /* Only the node it went to answers a fill. */
  if (waiting?.node !== keyOf(id)) return true;
  pending.delete(msg.requestId);
  waiting.done(msg);
  return true;
}

export function vaultNodeGone(ctx: Ctx, id: NodeIdentity): void {
  if (!ctx.hub.isOnline(id)) stateOf(ctx).fillers.delete(keyOf(id));
}

const webAddress = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const invalid = (message: string) => new ApiError(400, 'validation', message, 'vault_invalid');

/* The entry by its id or its name. Another company's id is refused as not this agent's, never as unknown. */
async function entryFor(ctx: Ctx, agent: VaultAgent, ref: string): Promise<Entry> {
  const byId = await entryById(ctx, ref);
  const entry = byId ?? (await entryByName(ctx, agent.companyId, ref));
  if (!entry) throw unknownEntry();
  if (!mayUse(entry, agent)) throw notAllowed(entry.companyId === agent.companyId ? 'This entry is kept for other agents.' : 'This entry is not of your company.');
  return entry;
}

/* The node the agent's turn runs on: the node of its browser. */
async function nodeOfJob(ctx: Ctx, jobId: string): Promise<{ node: NodeIdentity | null; taskId: string | null }> {
  const [row] = await ctx.db
    .select({ nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, taskId: jobs.taskId, kind: subscriptions.kind })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(eq(jobs.id, jobId));
  if (!row) return { node: null, taskId: null };
  return { node: identityOf({ kind: row.kind }, row.nodeId, row.builtinMachine, ownBuiltin(ctx.config)), taskId: row.taskId };
}

function fieldsFor(entry: Entry, asked: FillField[] | undefined, target: FillKind): FillField[] {
  if (asked?.length) {
    if (asked.includes('code') && !entry.totpEnc) throw invalid('This entry has no one-time code.');
    return [...new Set(asked)];
  }
  if (target === 'phone') throw invalid('On a phone, name the one field you tapped: login, password or code.');
  return entry.totpEnc ? ['login', 'password', 'code'] : ['login', 'password'];
}

async function targetFor(ctx: Ctx, state: State, agent: VaultAgent, entry: Entry, req: FillRequest): Promise<{ node: NodeIdentity | null; target: FillTarget }> {
  if (req.target === 'browser') {
    if (!webAddress(entry.site)) throw invalid("This entry's site is not a web address, so the browser does not know where it may sign in. A person sets the address in the vault.");
    const address = req.address ?? entry.site;
    /* The values go only into a page of the entry's own site, wherever an agent asks. */
    if (!webAddress(address) || !sameSite(entry.site, address)) throw notAllowed("This address is not of the entry's site.");
    const { node } = agent.jobId ? await nodeOfJob(ctx, agent.jobId) : { node: null };
    return { node, target: { kind: 'browser', address } };
  }
  if (!req.phoneSession) throw invalid('Name the phone session you hold.');
  if (!state.phones) return { node: null, target: { kind: 'phone', phoneSessionId: req.phoneSession, generation: 0, element: req.element ?? null } };
  const { node, generation } = await state.phones(ctx, agent, req.phoneSession);
  return { node, target: { kind: 'phone', phoneSessionId: req.phoneSession, generation, element: req.element ?? null } };
}

async function sealFor(recipient: string, plain: string): Promise<string> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return armor.encode(await e.encrypt(plain));
}

export async function fillEntry(ctx: Ctx, agent: VaultAgent, req: FillRequest): Promise<FillAnswer> {
  const state = stateOf(ctx);
  const entry = await entryFor(ctx, agent, req.entry);
  const fields = fieldsFor(entry, req.fields, req.target);
  const { node, target } = await targetFor(ctx, state, agent, entry, req);
  const taskId = agent.jobId ? (await nodeOfJob(ctx, agent.jobId)).taskId : null;
  const [use] = await ctx.db
    .insert(vaultLog)
    .values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'used', agentId: agent.id, jobId: agent.jobId, taskId, target: req.target, fields, status: 'sent' })
    .returning({ id: vaultLog.id });
  const end = async (status: FillAnswerStatus, extra: Partial<FillAnswer> = {}): Promise<FillAnswer> => {
    await ctx.db.update(vaultLog).set({ status, endedAt: new Date() }).where(eq(vaultLog.id, use!.id));
    return { entry: entry.name, target: req.target, status, filled: [], ...extra };
  };
  if (!node) return end('unsupported');
  if (!ctx.hub.isOnline(node)) return end('node_offline');
  const filler = state.fillers.get(keyOf(node));
  if (!filler?.fills.includes(req.target)) return end('unsupported');
  const requestId = randomUUID();
  const answered = new Promise<SecretFilled | null>(done => state.pending.set(requestId, { node: keyOf(node), done }));
  const sent = ctx.hub.send(node, {
    type: 'secret.fill', requestId, jobId: agent.jobId, entryId: entry.id,
    sealed: await sealFor(filler.publicKey, JSON.stringify(plainOf(ctx, entry))),
    fields, target, expiresAt: new Date(Date.now() + FILL_START_MS).toISOString(),
  });
  if (!sent) {
    state.pending.delete(requestId);
    return end('node_offline');
  }
  const answer = await Promise.race([answered, state.after(FILL_WAIT_MS).then(() => null)]);
  state.pending.delete(requestId);
  if (!answer) return end('no_answer');
  /* A sign-in the browser got is worth something only once kept for the agent's hh-browse. */
  const saved = answer.status === 'signed_in' && target.kind === 'browser' ? Boolean(answer.session) && (await saveSession(ctx, state, agent, target.address, answer.session!)) : undefined;
  return end(answer.status, { filled: answer.filled, ...(saved !== undefined ? { savedSignIn: saved } : {}), ...(answer.shot ? { shot: answer.shot } : {}) });
}

async function saveSession(ctx: Ctx, state: State, agent: VaultAgent, address: string, session: SiteSession): Promise<boolean> {
  if (!state.sessions) return false;
  return state.sessions(ctx, { companyId: agent.companyId, agentId: agent.id, site: new URL(address).origin, session }).catch(() => false);
}
