import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import { agents, jobs, subscriptions } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as, connectNode, until, type FakeNode } from './helpers.js';

export { nextOf as next } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

export type Screen = { ws: WebSocket; frames: { type: string; [k: string]: unknown }[]; closed: Promise<{ code: number; reason: string }> };
export type Refused = { status: number; reason?: string };

/* A browser that opens an agent's terminal: its screen, or how the server turned it away. */
export function open(url: string, token: string, agentId: string): Promise<Screen | Refused> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', `/api/agents/${agentId}/terminal?cols=100&rows=30`), { headers: { cookie: `hh_session=${token}` } });
    const frames: Screen['frames'] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    const closed = new Promise<{ code: number; reason: string }>(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, reason: body ? JSON.parse(body).error?.reason : undefined }));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, frames, closed }));
  });
}

export const opened = async (url: string, token: string, agentId: string): Promise<Screen> => {
  const screen = await open(url, token, agentId);
  if ('status' in screen) throw new Error(`Turned away: ${screen.status}`);
  return screen;
};

/* The visibility test company on the built-in node, whose API key plans let an agent move between plans on one machine. An open
   view looks again at its rights on its own only when a test asks for that pace. */
export async function company(env: NodeJS.ProcessEnv = {}) {
  const c = await aclCompany({ NODE_KEY, STREAM_PING_MS: '2147483647', ...env });
  await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
  const node = await connectNode(c.url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(() => c.app.ctx.hub.hasTerminals(BUILTIN));
  return { ...c, node, nodeIdentity: BUILTIN };
}
export type Company = Awaited<ReturnType<typeof company>>;

/* The node's mark comes back once the server handled all the node sent before it, and after all the server sent the node
   by then, as one socket keeps their order: no clock decides it. */
export async function handled(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: null, result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}

export const onPlan = (c: AclCompany, agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
export const moved = (c: AclCompany, agentId: string, planId: string) => c.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { subscription: planId }, ...as(c.tokens.ceo) });
/* Each turn starts after the one before it, as an agent's turns follow one another on a machine: two inserts in a row can
   fall into one millisecond, and turns that started together have no last one. */
let lastStart = 0;
export const turnOn = async (c: AclCompany, agentId: string, planId: string, status: 'running' | 'done' = 'running') => {
  lastStart = Math.max(Date.now(), lastStart + 1);
  const startedAt = new Date(lastStart);
  return (await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt, ...(status === 'done' ? { finishedAt: startedAt } : {}) }).returning())[0]!;
};
export const ended = (c: AclCompany, jobId: string) => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId));
export const state = async (c: AclCompany, token: string, agentId: string) => (await c.app.inject({ url: `/api/agents/${agentId}/events`, ...as(token) })).json().state;
