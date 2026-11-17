import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { FastifyServerOptions, RouteOptions } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { attachments, improvements, jobs, machines, tasks, testParts, testRuns, turns, vaultEntries, vaultLog } from '../src/db/schema.js';
import { addNote, companyBook, departmentBook } from '../src/modules/notebook/book.js';
import { ask } from '../src/modules/tasks/engine.js';
import { appFixture, as, testApp } from './helpers.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';

const captured = vi.hoisted(() => [] as RouteOptions[]);
vi.mock('fastify', async importOriginal => {
  const actual = await importOriginal<typeof import('fastify')>();
  return { ...actual, default: (options: FastifyServerOptions = {}) => {
    const app = actual.default(options);
    app.addHook('onRoute', route => { captured.push({ ...route }); });
    return app;
  } };
});

/* Every real route of the server has its place in this table, so a new one cannot show an agent by being forgotten. Run with
   HH_ACL_TABLE=<file> it writes what the routes really answered, for the people who build on them. */
const lines: string[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

type Crew = keyof AclCompany['crew'];
type Viewer = keyof AclCompany['tokens'];
type Call = { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: object };

/* One thing of one agent, and how a route reaches it. companyOnly: the route asks for the whole company before anything;
   ownerToo: or for the owner of the agent's department; rules: it asks for who changes the agent's rules, the CEO, the CEO
   delegate or the named owner of its department, and no one else of the whole company; ceos: it asks for the CEO or the CEO
   delegate alone; company: it is the company's work, which everyone of it reads. */
type Pointed = { route: string; of: (c: AclCompany, agent: Crew) => Promise<Call>; companyOnly?: boolean; ownerToo?: boolean; rules?: boolean; ceos?: boolean; company?: boolean; closedStatus?: 403 | 404 };
/* Who changes the rules of the agents that are open to them: Olga is the named owner of Development. */
const RULE_MAKERS: readonly Viewer[] = ['ceo', 'clara', 'olga'];
/* The CEO and Clara, the CEO's delegate. */
const CEOS: readonly Viewer[] = ['ceo', 'clara'];

const anAgent = (method: Call['method'], end: string, payload?: object) => async (c: AclCompany, agent: Crew): Promise<Call> => ({ method, url: `/api/agents/${c.crew[agent].id}${end}`, ...(payload ? { payload } : {}) });
const aTask = (method: Call['method'], end: string, payload?: object) => async (c: AclCompany, agent: Crew): Promise<Call> => {
  const task = await c.work(`Work of ${String(agent)}`, c.crew[agent], c.crew[agent].departmentId!);
  return { method, url: `/api/tasks/${task.id}${end}`, ...(payload ? { payload } : {}) };
};
const aJob = (method: Call['method'], end: string) => async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.crew[agent].subscriptionId!, agentId: c.crew[agent].id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'done', finishedAt: new Date() }).returning();
  return { method, url: `/api/jobs/${job!.id}${end}` };
};
const anIdea = (end: string) => async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [idea] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew[agent].id, title: 'Idea', text: 'x' }).returning();
  return { method: 'POST', url: `/api/improvements/${idea!.id}/${end}` };
};
/* A finding about Hornhoof itself, sent on from its card: the window shows what goes, and only the right digest sends it. */
const aFinding = (url: string, extra: object = {}) => async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [finding] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew[agent].id, title: 'Finding', text: 'x', scope: 'platform' }).returning();
  return { method: 'POST', url, payload: { kind: 'bug', title: 'Finding', text: 'x', improvement: finding!.id, ...extra } };
};
/* Its repeats, told from its card: a finding not sent yet has none to tell, so nothing reaches the relay from here. */
const aRepeated = async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [finding] = await c.db.insert(improvements).values({ companyId: c.companyId, agentId: c.crew[agent].id, title: 'Finding', text: 'x', scope: 'platform' }).returning();
  return { method: 'POST', url: '/api/feedback/repeats', payload: { improvement: finding!.id } };
};
const aPicture = async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [picture] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew[agent].id, personId: c.ids.ceo, name: 'p.png', mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning();
  return { method: 'GET', url: `/api/attachments/${picture!.id}` };
};

/* The company's saved sign-in this agent took: the log names the agent. */
let vaultUses = 0;
const aVaultUse = async (c: AclCompany, agent: Crew): Promise<Call> => {
  const [entry] = await c.db.insert(vaultEntries).values({ companyId: c.companyId, name: `Sign-in ${++vaultUses} of ${String(agent)}`, site: 'https://partner.example', login: 'team', passwordEnc: 'x', createdBy: c.ids.ceo }).returning();
  await c.db.insert(vaultLog).values({ companyId: c.companyId, entryId: entry!.id, entryName: entry!.name, site: entry!.site, kind: 'taken', agentId: c.crew[agent].id });
  return { method: 'GET', url: `/api/vault/${entry!.id}/log` };
};

const POINTED: Pointed[] = [
  { route: 'GET /api/agents/:id', of: anAgent('GET', '') },
  { route: 'PATCH /api/agents/:id', of: anAgent('PATCH', '', { effort: null }) },
  { route: 'DELETE /api/agents/:id', of: anAgent('DELETE', ''), companyOnly: true, ownerToo: true },
  { route: 'GET /api/agents/:id/events', of: anAgent('GET', '/events') },
  { route: 'POST /api/agents/:id/messages', of: anAgent('POST', '/messages', { text: 'hi' }) },
  { route: 'POST /api/agents/:id/pictures', of: async (c, agent) => ({ method: 'POST', url: `/api/agents/${c.crew[agent].id}/pictures`, payload: {} }) },
  { route: 'POST /api/agents/:id/reset', of: anAgent('POST', '/reset', {}) },
  { route: 'POST /api/agents/:id/start', of: anAgent('POST', '/start', {}) },
  { route: 'POST /api/agents/:id/stop', of: anAgent('POST', '/stop', {}) },
  { route: 'GET /api/agents/:id/terminal', of: anAgent('GET', '/terminal') },
  /* The inbox opens with the employee; its letters are marked and its mode changed by who changes the employee's rules. */
  { route: 'GET /api/agents/:id/inbox', of: anAgent('GET', '/inbox') },
  { route: 'POST /api/agents/:id/inbox/read', of: anAgent('POST', '/inbox/read', { all: true }), rules: true },
  /* Marking any of its letters read or done, by a choice of them and with a reason, is the CEO's and the delegate's alone. */
  { route: 'POST /api/agents/:id/inbox/mark', of: anAgent('POST', '/inbox/mark', { status: 'read', receivedBefore: '2100-01-01T00:00:00.000Z', reason: 'Stale.' }), ceos: true },
  { route: 'PUT /api/agents/:id/inbox-mode', of: anAgent('PUT', '/inbox-mode', { mode: 'direct' }), rules: true },
  /* A token that is no token: nothing reaches Telegram, and an open case is refused only for what it sent. */
  { route: 'PUT /api/agents/:id/telegram', of: anAgent('PUT', '/telegram', { token: 'no token' }), companyOnly: true, ownerToo: true },
  { route: 'DELETE /api/agents/:id/telegram', of: anAgent('DELETE', '/telegram'), companyOnly: true, ownerToo: true },
  { route: 'GET /api/tasks/:id', of: aTask('GET', ''), company: true },
  { route: 'GET /api/tasks/:id/waits', of: aTask('GET', '/waits'), company: true },
  /* Who took a sign-in of the vault is the company's work; another person's own assistant stays out of it. */
  { route: 'GET /api/vault/:id/log', of: aVaultUse, company: true },
  { route: 'POST /api/tasks/:id/comments', of: aTask('POST', '/comments', { text: 'hi' }) },
  { route: 'POST /api/tasks/:id/cancel', of: aTask('POST', '/cancel', {}) },
  { route: 'PATCH /api/tasks/:id', of: aTask('PATCH', '', { why: 'Shops sell online.', version: 0, revision: 0 }) },
  { route: 'GET /api/jobs/:id', of: aJob('GET', '') },
  { route: 'POST /api/jobs/:id/cancel', of: aJob('POST', '/cancel'), companyOnly: true, ownerToo: true },
  { route: 'POST /api/improvements/:id/take', of: anIdea('take'), companyOnly: true },
  { route: 'POST /api/improvements/:id/dismiss', of: anIdea('dismiss'), companyOnly: true },
  { route: 'POST /api/feedback/preview', of: aFinding('/api/feedback/preview'), companyOnly: true },
  /* A digest of nothing: what reaches the relay is never sent from here. */
  { route: 'POST /api/feedback', of: aFinding('/api/feedback', { digest: '0'.repeat(64) }), companyOnly: true },
  { route: 'POST /api/feedback/repeats', of: aRepeated, companyOnly: true },
  /* Hidden attachments have the same answer as missing files; other closed resources still answer 403. */
  { route: 'GET /api/attachments/:id', of: aPicture, closedStatus: 404 },
];

/* Who asks about whose: closed in every case but their own agent and the full view. */
const CASES: { name: string; viewer: Viewer; agent: Crew; closed: boolean }[] = [
  { name: 'own plan, own department', viewer: 'ann', agent: 'mine', closed: false },
  { name: "another's plan, own department", viewer: 'ann', agent: 'other', closed: true },
  { name: 'own plan, other department', viewer: 'ann', agent: 'away', closed: true },
  { name: "another's plan, other department", viewer: 'ann', agent: 'far', closed: true },
  { name: 'department owner, own plan', viewer: 'olga', agent: 'owned', closed: false },
  { name: "department owner, another's plan", viewer: 'olga', agent: 'other', closed: false },
  { name: "department owner, another's plan, other department", viewer: 'olga', agent: 'far', closed: true },
  { name: 'whole company, own plan', viewer: 'wes', agent: 'wide', closed: false },
  { name: "whole company, another's plan", viewer: 'wes', agent: 'other', closed: true },
  { name: 'delegate', viewer: 'clara', agent: 'far', closed: false },
  { name: 'CEO', viewer: 'ceo', agent: 'deputy', closed: false },
];

/* Lists, with what each person gets. company: it names every employee and the work of the company, which everyone of it
   sees, and keeps only the words of the agents a person does not open. */
type Listed = { route: string; url: (c: AclCompany) => string; statuses: Partial<Record<Viewer, number>>; company?: boolean };
const ALL_OK = { ann: 200, olga: 200, wes: 200, clara: 200, ceo: 200 };
const WHOLE_ONLY = { ann: 403, olga: 403, wes: 200, clara: 200, ceo: 200 };
/* Ann has App, a product of Development, and not the department itself: for her it does not exist, and its notebook is closed. */
const DEPARTMENT_ITSELF = { ann: 404, olga: 200, wes: 200, clara: 200, ceo: 200 };
const LISTS: Listed[] = [
  { route: 'GET /api/org', url: () => '/api/org', statuses: ALL_OK, company: true },
  { route: 'GET /api/tasks', url: c => `/api/tasks?status=all&department=${c.dev.id}`, statuses: ALL_OK, company: true },
  { route: 'GET /api/requests', url: () => '/api/requests', statuses: ALL_OK },
  { route: 'GET /api/wait-cards', url: () => '/api/wait-cards', statuses: ALL_OK },
  { route: 'GET /api/turns', url: () => '/api/turns', statuses: ALL_OK },
  { route: 'GET /api/turns/current', url: () => '/api/turns/current', statuses: ALL_OK },
  { route: 'GET /api/subscriptions', url: () => '/api/subscriptions', statuses: ALL_OK },
  { route: 'GET /api/machines', url: () => '/api/machines', statuses: ALL_OK },
  { route: 'GET /api/phones', url: () => '/api/phones', statuses: ALL_OK },
  { route: 'GET /api/pool', url: () => '/api/pool', statuses: ALL_OK },
  { route: 'GET /api/people', url: () => '/api/people', statuses: ALL_OK },
  { route: 'GET /api/me', url: () => '/api/me', statuses: ALL_OK },
  { route: 'GET /api/improvements', url: () => '/api/improvements', statuses: WHOLE_ONLY },
  { route: 'GET /api/notebook', url: () => '/api/notebook', statuses: WHOLE_ONLY },
  { route: 'GET /api/computer', url: () => '/api/computer', statuses: WHOLE_ONLY },
  { route: 'GET /api/machines/access', url: () => '/api/machines/access', statuses: ALL_OK },
  { route: 'GET /api/machines/here', url: () => '/api/machines/here', statuses: ALL_OK },
  { route: 'GET /api/updates', url: () => '/api/updates', statuses: WHOLE_ONLY },
  { route: 'GET /api/departments/:id/notebook', url: c => `/api/departments/${c.dev.id}/notebook`, statuses: { ...DEPARTMENT_ITSELF, ann: 403 } },
  { route: 'GET /api/departments/:id/tree', url: c => `/api/departments/${c.dev.id}/tree`, statuses: ALL_OK, company: true },
  { route: 'GET /api/departments/:id/pipeline', url: c => `/api/departments/${c.dev.id}/pipeline`, statuses: ALL_OK, company: true },
  { route: 'GET /api/departments/:id/roster', url: c => `/api/departments/${c.dev.id}/roster`, statuses: { ann: 403, olga: 200, wes: 200, clara: 200, ceo: 200 } },
  { route: 'GET /api/departments/:id/approval-policy', url: c => `/api/departments/${c.dev.id}/approval-policy`, statuses: DEPARTMENT_ITSELF },
  { route: 'GET /api/autonomous-releases', url: () => '/api/autonomous-releases', statuses: ALL_OK, company: true },
  { route: 'GET /api/vault', url: () => '/api/vault', statuses: ALL_OK, company: true },
  { route: 'GET /api/departments/:id/wait-policy', url: c => `/api/departments/${c.dev.id}/wait-policy`, statuses: ALL_OK },
  /* Ann has App of Development and does not run Development: its branches are closed to her, as its roster is. */
  { route: 'GET /api/departments/:id/branches', url: c => `/api/departments/${c.dev.id}/branches`, statuses: { ann: 403, olga: 200, wes: 200, clara: 200, ceo: 200 } },
];

/* Elsewhere, with the reason it is not a row above. */
const ELSEWHERE: Record<string, string> = {
  'PUT /api/departments/:id/approval-policy/autonomous-release': 'autonomous-release.test.ts: the signed-in human CEO alone, 403 for every other person and every agent',
  'PUT /api/departments/:id/wait-policy/:kind': 'agent-view-waits.test.ts: only this department owner, CEO or delegate; every role checked',
  'POST /api/waits/:id/replan': 'agent-view-waits.test.ts: visible task and responsible wait owner/decider, CEO or delegate',
  'POST /api/wait-cards/:id/ack': 'agent-view-waits.test.ts: delivered card recipient only, 404 for another person even the CEO',
  'GET /api/stream': 'agent-view-stream.test.ts: filtered per message',
  'PUT /api/departments/:id/inbox-mode': "inbox.test.ts: the department's owner, the CEO or the CEO delegate, 403 for another one, 404 for a product",
  'PUT /api/company/inbox-mode': 'inbox.test.ts: the CEO or the CEO delegate alone, 403 for everyone else',
  'PUT /api/tasks/:id/urgent': 'task-urgency.test.ts, department-owner-rights.test.ts: the CEO or the department owner, 403 for everyone else who sees the task',
  'PUT /api/tasks/:id/paused': 'task-pause.test.ts, department-owner-rights.test.ts: the CEO or the department owner, 403 for everyone else who sees the task',
  'POST /api/tasks/:id/close': 'orchestrator-close.test.ts: the orchestrator alone, through its own calls; 403 for every person, the CEO too, and for a head',
  'GET /api/goals': "tracker-goals.test.ts: the company's goals with their progress, which everyone of it reads",
  'GET /api/goals/:id': 'tracker-goals.test.ts: one goal of the company and its history, which everyone of it reads',
  'POST /api/goals': "tracker-goals.test.ts: company goals by the CEO or a delegate, a department's by whoever reaches it, 403 for everyone else",
  'PATCH /api/goals/:id': "tracker-goals.test.ts: company goals by the CEO or a delegate, a department's by whoever reaches it, 403 for everyone else",
  'PUT /api/goals/:id/status': "tracker-goals.test.ts: company goals by the CEO or a delegate, a department's by whoever reaches it, 403 for everyone else",
  'GET /api/pipelines': "tracker-pipelines.test.ts: the departments' pipelines, which everyone of the company reads",
  'POST /api/pipelines': 'tracker-pipelines.test.ts: whoever reaches the department, 403 for everyone else',
  'PATCH /api/pipelines/:id': 'tracker-pipelines.test.ts: whoever reaches the department, 403 for everyone else',
  'POST /api/pipelines/:id/archive': 'tracker-pipelines.test.ts: whoever reaches the department, 403 for everyone else',
  'GET /api/task-departments': "backlog.test.ts: every department of the company, which everyone sees, with the person's own marked",
  'GET /api/departments/:id/briefing': 'briefings.test.ts: a person with the department or the whole company, 403 for another one',
  'PUT /api/departments/:id/briefing': 'briefings.test.ts: a person with the department or the whole company, 403 for another one',
  'GET /api/departments/:id/backlog': 'backlog.test.ts: a person with the department, 403 for another one',
  'POST /api/departments/:id/backlog': 'backlog.test.ts: a person with the department, 403 for another one',
  'PUT /api/departments/:id/backlog/order': 'backlog.test.ts: a person with the department, 403 for another one',
  'DELETE /api/departments/:id/backlog/:item': 'backlog.test.ts: a person with the department and an item of it, 403 or 404 otherwise',
  'POST /api/departments/:id/backlog/schedule': 'backlog.test.ts: a person with the department and items of it, 403 or 409 otherwise',
  'POST /api/requests/:id': 'agent-view-lists.test.ts: the request authority, 403 otherwise',
  'POST /api/tasks': 'agent-view.test.ts: the answer is read as the person who gave it',
  'POST /api/requests/:id/explained': 'the orchestrator alone',
  'GET /api/phones/:id': 'phones.test.ts: phone metadata of this company, 403 for another company; the connection address is shown only to its owner',
  'GET /api/phones/:id/live': 'phone-recording.test.ts, phones.test.ts: the signed-in phone owner or the orchestrator acting for the CEO reads the live frame; 403 for another person or a head',
  'GET /api/phones/:id/live/image': 'phone-recording.test.ts, phones.test.ts: the same phone-owner or orchestrator check protects the live image, never the rights of a task viewer',
  'GET /api/tasks/:id/phone-recordings': 'phone-recording.test.ts: a visible task of this company, with recordings filtered to agents the viewer may open',
  'GET /api/phone-sessions/:id/frames/:sequence/image': 'phone-recording.test.ts: a recording of this company whose task and agent the viewer may open; 403 otherwise',
  'GET /api/assistant/me': "assistants-rights.test.ts: an assistant key, read with its owner's rights as they are now",
  'GET /api/assistant/agents': "assistants-rights.test.ts: exactly the agents its owner may write to in the agent's window",
  'POST /api/assistant/messages': "assistants-rights.test.ts, assistants-messages.test.ts: an agent its owner may write to, 403 otherwise",
  'GET /api/assistant/events': 'assistants-events.test.ts: the events of this assistant alone',
  'GET /api/assistant/requests': 'assistants-events.test.ts: the requests that wait for its owner',
  'POST /api/assistant/requests/:id/answer': 'assistants-events.test.ts: what its owner may answer, 403 otherwise',
  'POST /api/assistant/files': "assistants-messages.test.ts, assistants-rights.test.ts: a file of any type for an agent its owner may write to, kept as its owner's own; 403 for one the owner does not write to, 404 for none",
  'GET /api/files/*': "assistants-files.test.ts, assistants-events.test.ts: the one file a signed link in a reply to an assistant names, with no key or sign-in, for 7 days; 410 after them, and the same 404 for a link changed, signed for anything else or of a file that is gone",
  'GET /api/assistant/attachments/:id': "assistants-files.test.ts, assistant-agent.test.ts: a file its owner may download in the interface, by the assistant's key alone; 401 otherwise, and the same 404 for a file its owner may not see, another company's or none",
  'POST /api/assistant/mcp': "assistants-mcp.test.ts: the same reads and writes over MCP, by the assistant's key and with its owner's rights",
  'GET /api/assistant/mcp': 'assistants-mcp.test.ts: 405, the MCP door takes POST alone',
  'DELETE /api/assistant/mcp': 'assistants-mcp.test.ts: 405, the MCP door takes POST alone',
  'GET /api/feedback/inbox': "feedback-inbox.test.ts: only on Hornhoof's own installation, a person with the whole company, 403 for another one; its cards came from installations, not from this company's agents",
  'POST /api/feedback/inbox/:id/issue': "feedback-issue.test.ts: only on Hornhoof's own installation, a person with the whole company, 403 for another one",
};

/* Routes that show no agent and no work. Writes keep the rights they had; their answers name nothing of other agents. */
const NO_AGENT_DATA: string[] = [
  'POST /api/attachments', 'GET /api/attachments/file', 'POST /api/auth/login', 'POST /api/auth/logout',
  'POST /api/vault', 'PATCH /api/vault/:id', 'DELETE /api/vault/:id',
  'POST /api/computer/close', 'POST /api/computer/decline', 'POST /api/computer/open',
  'POST /api/machines/:id/access/close', 'POST /api/machines/:id/access/decline', 'POST /api/machines/:id/access/open',
  /* A person or the orchestrator registers and probes; the phone owner or the orchestrator stops and resumes, never a head. */
  'POST /api/phones/probe', 'POST /api/phones', 'POST /api/phones/:id/stop', 'POST /api/phones/:id/resume',
  'GET /api/feedback', 'POST /api/feedback/inbound',
  'PUT /api/departments/:id/approval-policy/:channel', 'POST /api/departments/:id/notebook', 'PATCH /api/departments/:id/notebook/:number', 'DELETE /api/departments/:id/notebook/:number',
  'PUT /api/departments/:id/owner', 'PUT /api/departments/:id/repository', 'DELETE /api/departments/:id/repository', 'POST /api/departments/:id/repositories', 'POST /api/departments/:id/staff',
  'POST /api/departments/:id/repositories/new', 'PUT /api/departments/:id/repo-host', 'DELETE /api/departments/:id/repo-host', 'GET /api/repo-host', 'PUT /api/repo-host', 'DELETE /api/repo-host',
  'GET /api/google-sheets', 'PUT /api/google-sheets', 'DELETE /api/google-sheets',
  'POST /api/departments/:id/teams', 'PATCH /api/departments/:id/teams/:teamId', 'DELETE /api/departments/:id/teams/:teamId', 'POST /api/departments/build',
  'GET /api/health', 'GET /api/invites/:token', 'POST /api/invites/:token/accept',
  'GET /api/link', 'PUT /api/link', 'DELETE /api/link', 'GET /api/link/names/:name',
  'GET /api/map/layout', 'PATCH /api/map/layout', 'DELETE /api/map/layout',
  'PATCH /api/machines/:id', 'GET /api/machines/:id/connections', 'POST /api/machines/:id/core', 'POST /api/machines/:id/disconnect', 'PUT /api/machines/:id/priority', 'POST /api/machines/:id/move', 'DELETE /api/machines/:id/move', 'POST /api/machines/:id/plans', 'POST /api/machines/:id/programs/update', 'POST /api/machines/command',
  'GET /api/me/key', 'PUT /api/me/key',
  'GET /api/backups', 'POST /api/backups/recovery', 'GET /api/backups/recovery', 'GET /api/backups/:id/warning', 'POST /api/backups/:id/restore', 'POST /api/backups/kept/:name/leave', 'GET /api/merges/:id/conflicts', 'POST /api/merges/pick', 'GET /api/network/backups', 'POST /api/network/backups', 'GET /api/network/switch', 'GET /api/network/switched', 'GET /api/network/question', 'POST /api/network/question/go-on', 'POST /api/network/question/wait', 'POST /api/network/certificate', 'GET /api/network/computer', 'POST /api/network/computer/:id', 'POST /api/network/join', 'GET /api/network/peers', 'POST /api/network/renew', 'POST /api/network/report', 'POST /api/network/secrets',
  'GET /api/nodes/commands', 'POST /api/nodes/commands/:id/hide', 'POST /api/nodes/join', 'GET /api/nodes/socket', 'POST /api/nodes/update', 'DELETE /api/nodes/update',
  'POST /api/notebook', 'PATCH /api/notebook/:number', 'DELETE /api/notebook/:number',
  'GET /api/parts/:id/files/:name', 'PUT /api/parts/:id/files/:name',
  'POST /api/harness/claim', 'POST /api/harness/:key/done', 'POST /api/harness/:key/failed', 'GET /api/harness/:key/bundle', 'PUT /api/harness/:key/parts/:index',
  'PATCH /api/people/:id', 'PUT /api/people/:id/ceo-delegate', 'POST /api/people/:id/invite', 'POST /api/people/invite',
  'POST /api/people/assistants', 'PATCH /api/people/:id/assistant', 'POST /api/people/:id/key', 'DELETE /api/people/:id/key',
  'GET /api/setup', 'POST /api/setup', 'GET /api/setup/names/:name',
  'POST /api/recovery', 'GET /api/recovery', 'POST /api/recovery/restore', 'POST /api/recovery/challenge', 'PUT /api/recovery/bundles/:id',
  'POST /api/subscriptions', 'PATCH /api/subscriptions/:id', 'DELETE /api/subscriptions/:id', 'POST /api/subscriptions/:id/command', 'POST /api/subscriptions/:id/credential', 'POST /api/subscriptions/:id/orchestrator',
  'GET /api/subscriptions/:id/recipients', 'POST /api/subscriptions/models', 'POST /api/subscriptions/:id/models', 'GET /api/subscriptions/:id/tokens', 'GET /api/tokens', 'POST /api/subscriptions/:id/signin', 'POST /api/subscriptions/:id/signin/stop', 'GET /api/subscriptions/:id/signin/terminal', 'POST /api/subscriptions/:id/test', 'POST /api/subscriptions/connect',
  'POST /api/updates', 'DELETE /api/updates', 'POST /api/updates/check', 'GET /api/updates/current', 'GET /api/version', 'GET /install.sh', 'GET /install.ps1', 'POST /mcp', 'GET /mcp', 'DELETE /mcp',
  'GET /robots.txt', 'GET /.well-known/acme-challenge/*',
];

const call = (c: AclCompany, { method, url, payload }: Call, viewer: Viewer) => c.app.inject({ method, url, ...(payload ? { payload } : {}), ...as(c.tokens[viewer]) });

/* A company with work in every corner: tasks, a turn, requests, notes, ideas and running parts of every agent. */
async function busy() {
  const c = await aclCompany();
  const work = await appFixture(c.app, 'agent visibility company with work', async () => {
    const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'Turn', status: 'open', messages: [{ by: 'Ivan', text: 'Secret words', at: new Date().toISOString() }], openedAt: new Date(Date.now() - 3_600_000) }).returning();
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ids.wes, machineKey: 'wes-machine-12345', hostname: 'wes-box' }).returning();
    const work: Partial<Record<Crew, typeof tasks.$inferSelect>> = {};
    let number = 0;
    for (const key of Object.keys(c.crew) as Crew[]) {
      const agent = c.crew[key];
      const task = await c.work(`Secret of ${agent.name}`, agent, agent.departmentId!);
      work[key] = task;
      await c.db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, task.id));
      await ask(c.app.ctx, agent.id, task.id, { text: wordsOf(key), kind: 'approval', approval: { channel: 'spend', kind: 'ads', amount: 1 } });
      await c.db.insert(improvements).values({ companyId: c.companyId, agentId: agent.id, title: `Idea of ${agent.name}`, text: 'x' });
      await addNote(c.app.ctx, agent.departmentId === c.dev.id ? departmentBook(c.dev) : departmentBook(c.sales), `Note ${number}`, { personId: null, byOrchestrator: false, agentId: agent.id });
      await addNote(c.app.ctx, companyBook(c.companyId), `Company note ${number}`, { personId: null, byOrchestrator: false, agentId: agent.id });
      const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: agent.subscriptionId!, agentId: agent.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
      const [run] = await c.db.insert(testRuns).values({ companyId: c.companyId, number: ++number, kind: 'tests', departmentId: agent.departmentId!, taskId: task.id, agentId: agent.id, jobId: job!.id, branch: 'main', command: 'echo ok', parts: 1, timeoutMs: 60_000, status: 'running' }).returning();
      await c.db.insert(testParts).values({ runId: run!.id, companyId: c.companyId, part: 1, status: 'running', machineId: box!.id, startedAt: new Date() });
    }
    return work as Record<Crew, typeof tasks.$inferSelect>;
  });
  return { ...c, tasksOf: work };
}

/* What each person may open of the crew. */
const SEEN: Partial<Record<Viewer, Crew[]>> = { ann: ['mine'], olga: ['mine', 'other', 'head', 'owned'], wes: ['wide'] };

/* What an agent asks in the busy company: its own words. */
const wordsOf = (key: Crew) => `Please decide what ${String(key)} asks`;

describe('every real route', () => {
  it('has its place in the table', async () => {
    captured.length = 0;
    await testApp();
    /* The files of the built web app, which holds no agent's data and which a server has only once the web was built. */
    const real = new Set(captured.filter(r => r.url !== '/*').flatMap(r => [r.method].flat().filter(m => m !== 'HEAD').map(m => `${String(m)} ${r.url}`)));
    const placed = new Set([...POINTED.map(p => p.route), ...LISTS.map(l => l.route), ...Object.keys(ELSEWHERE), ...NO_AGENT_DATA]);
    expect([...real].filter(r => !placed.has(r)).sort()).toEqual([]);
    expect([...placed].filter(r => !real.has(r)).sort()).toEqual([]);
  });
});

describe('one thing of one agent', () => {
  it.each(POINTED)('$route', async ({ route, of, companyOnly, ownerToo, rules, ceos, company, closedStatus = 403 }) => {
    const c = await aclCompany();
    const got: string[] = [];
    /* Those that are closed first: what opens may change or remove what it is given. */
    for (const { name, viewer, agent, closed } of [...CASES].sort((a, b) => Number(b.closed) - Number(a.closed))) {
      const res = await call(c, await of(c, agent), viewer);
      got.push(`${name}: ${res.statusCode}`);
      const scoped = ceos ? !CEOS.includes(viewer) : rules ? !RULE_MAKERS.includes(viewer) : companyOnly && (viewer === 'ann' || (viewer === 'olga' && !ownerToo));
      if (company) expect(res.statusCode, `${route}, ${name}`).toBe(200);
      else if (closed || scoped) expect(res.statusCode, `${route}, ${name}`).toBe(closedStatus);
      else expect([403, closedStatus], `${route}, ${name}`).not.toContain(res.statusCode);
      if (closed && !company) expect(leaks(res, [c.crew[agent]]), `${route}, ${name}`).toEqual([]);
    }
    lines.push(`| ${route} | ${got.join('; ')} |`);
  });
});

describe('every list', () => {
  it.each(LISTS)('$route shows each person only what they may see', async ({ route, url, statuses, company }) => {
    const c = await busy();
    const got: string[] = [];
    for (const [viewer, status] of Object.entries(statuses) as [Viewer, number][]) {
      const res = await c.get(url(c), c.tokens[viewer]);
      got.push(`${viewer}: ${res.statusCode}`);
      expect(res.statusCode, `${route} for ${viewer}`).toBe(status);
      const seen = SEEN[viewer];
      if (!seen) continue;
      const hidden = (Object.keys(c.crew) as Crew[]).filter(k => !seen.includes(k));
      for (const key of hidden) {
        const hiddenWork = [c.crew[key], { id: c.tasksOf[key].id, name: c.tasksOf[key].title }];
        if (!company) expect(leaks(res, hiddenWork), `${route} for ${viewer}: ${key}`).toEqual([]);
        expect(res.body, `${route} for ${viewer}: ${key}`).not.toContain(wordsOf(key));
      }
      expect(res.body, `${route} for ${viewer}`).not.toContain('Secret words');
      /* The orchestrator's circle shows on the map to everyone, without opening him. */
      if (route !== 'GET /api/org') expect(res.body, `${route} for ${viewer}`).not.toContain(c.orchestrator.id);
    }
    lines.push(`| ${route} | ${got.join('; ')} |`);
  });
});

afterAll(() => {
  const file = process.env.HH_ACL_TABLE;
  if (!file) return;
  const elsewhere = Object.entries(ELSEWHERE).map(([route, why]) => `| ${route} | ${why} |`);
  writeFileSync(file, ['| Route | Who gets what (real responses) |', '| --- | --- |', ...[...lines].sort(), ...elsewhere, '', `No agent or work data, rights unchanged: ${NO_AGENT_DATA.join(', ')}`, ''].join('\n'));
});
