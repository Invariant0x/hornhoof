import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import { agents, jobs, subscriptions } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as, connectNode, until, type FakeNode } from './helpers.js';

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

export async function next<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const m = await node.next();
    if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

/* The company of #398 on the built-in node, whose API key plans let an agent move between plans on one machine. */
export async function company(env: NodeJS.ProcessEnv = {}) {
  const c = await aclCompany({ NODE_KEY, STREAM_PING_MS: '60000', ...env });
  await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
  const node = await connectNode(c.url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(() => c.app.ctx.hub.hasTerminals(BUILTIN));
  return { ...c, node, nodeIdentity: BUILTIN };
}
export type Company = Awaited<ReturnType<typeof company>>;

export const onPlan = (c: AclCompany, agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
export const moved = (c: AclCompany, agentId: string, planId: string) => c.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { subscription: planId }, ...as(c.tokens.ceo) });
export const turnOn = async (c: AclCompany, agentId: string, planId: string, status: 'running' | 'done' = 'running') =>
  (await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt: new Date(), ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning())[0]!;
export const ended = (c: AclCompany, jobId: string) => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId));
export const state = async (c: AclCompany, token: string, agentId: string) => (await c.app.inject({ url: `/api/agents/${agentId}/events`, ...as(token) })).json().state;
