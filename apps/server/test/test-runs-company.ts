import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { pumpTests } from '../src/modules/testruns/runs.js';
import type { Ctx } from '../src/app.js';
import { appFixture, as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, type FakeNode } from './helpers.js';
import { BUILTIN } from './builtin.js';
import { stored } from './files-fixture.js';

export const GIB = 1024 ** 3;

export { nextOf as nextOf } from './helpers.js';

export const NODE_KEY = 'builtin-node-key-0123456789abcdef';

export const idle = (over: object = {}) => ({ cpus: 8, load: 0.5, memFree: 12 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });

type Res = { content: { text: string }[]; isError?: boolean };

type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

/* A company whose development department has a repository, with Bruno at work on #1 there. */
export async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  /* Its departments, people and task, made once in a file and put back for each of its tests. */
  const { companyId, dev, sales, sub, head, bruno, sam, task, ann, bob } = await appFixture(app, 'test-runs company', async () => {
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [dev, sales] = await db
      .insert(departments)
      .values([
        { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git', repoTokenEnc: encryptSecret('ghp_shop0123456789', app.ctx.config.secret), repoTokenLast4: '6789' },
        { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
      ])
      .returning();
    const [sub] = await db.select().from(subscriptions);
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
      (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
    const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true })).task;
    const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [dev!.id] } });
    const bob = await invitePerson(app, ceo, { name: 'Bob', email: 'bob@acme.com', access: { departments: [sales!.id] } });
    return { companyId, dev: dev!, sales: sales!, sub: sub!, head, bruno, sam, task, ann, bob };
  });
  let n = 0;
  /* A running turn of the agent on a task, and its tools. */
  const turn = async (agent: { id: string }, taskId: string | null = task.id) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub.id, agentId: agent.id, taskId, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(Date.now() - 1000), toolTokenHash: hashToken(token) })
      .returning();
    const client = await mcp(app, token);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Res;
      return { text: res.content[0]!.text, error: res.isError === true };
    };
    return { job: job!, call };
  };
  /* A machine of a person with one node, online with this load. */
  const machine = async (token: string, hostname: string, load: object = idle(), { work = true, kind, noRuns }: { work?: boolean; kind?: string; noRuns?: string } = {}) => {
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(token) });
    const code = connected.json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64', ...(kind ? { kind } : {}) } })).json();
    const [{ nodeId, subscriptionId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [], work, ...(noRuns ? { noRuns } : {}) });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, key: key as string, nodeId: nodeId as string, subscriptionId: subscriptionId as string, machineId: joined.machine.id as string };
  };
  /* A machine of a person that joined without a plan, online with this load. */
  const planless = async (token: string, hostname: string, load: object = idle()) => {
    const code = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, nodeId: nodeId as string, machineId: joined.machine.id as string };
  };
  /* The same machine's node back online after it was away. */
  const reconnect = async (m: { key: string; nodeId: string }, load: object = idle()) => {
    const node = await connectNode(url, m.key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [], work: true });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(m.nodeId)) !== null);
    return node;
  };
  /* A file on the task, as an agent puts it there. */
  const putFile = async (name: string, text: string, taskId = task.id) => {
    const [made] = await db.select(idOnly(jobs)).from(jobs).limit(1);
    const bytes = Buffer.from(text);
    await db.insert(attachments).values({ companyId, jobId: made!.id, agentId: bruno.id, taskId, name, mediaType: 'application/octet-stream', sha256: await stored(db, bytes, app.ctx.config), size: bytes.length });
  };
  /* The agent's newest turn waiting on the task. */
  const wokeWith = async (agentId: string, taskId = task.id) =>
    (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt))).pop()?.prompt ?? null;
  const filesOn = async (taskId = task.id) => {
    const rows = await db.select({ name: attachments.name, sha256: attachments.sha256 }).from(attachments).where(eq(attachments.taskId, taskId)).orderBy(asc(attachments.name));
    return Promise.all(rows.map(async f => ({ name: f.name, text: (await app.ctx.files.bytes(db, f.sha256!)).toString('utf8') })));
  };
  /* The built-in node, online with this load. */
  const builtin = async (load: object = idle()) => {
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf(BUILTIN) !== null);
    return node;
  };
  return { app, db, url, ceo, ann, bob, builtin, dev, sales, head, bruno, sam, task, turn, machine, planless, reconnect, putFile, wokeWith, filesOn };
}

/* The node's mark comes back after everything the server sent it before, as one socket keeps their order, and after every
   message the node sent before it was handled. */
async function marked(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}

/* Whether a node got a message of this kind from everything the server has given it so far; what came meanwhile is taken.
   What the node said is handled first, then every round of giving out tests under way ends, and what it gave out has
   arrived: no clock decides it. */
export async function gets(ctx: Ctx, node: FakeNode, type: ServerMessage['type']): Promise<boolean> {
  await marked(node);
  await pumpTests(ctx);
  await marked(node);
  let got = false;
  for (let n = node.queued(); n > 0; n--) if ((await node.next()).type === type) got = true;
  return got;
}

export const done = (run: TestsRun, over: object = {}) => ({ type: 'tests.done' as const, partId: run.partId, ok: true, exitCode: 0, error: null, commit: 'a'.repeat(40), log: `part ${run.part} ok\n`, ...over });

/* The scheduler consumes optional physical resources at the hub boundary. */
export const reportHost = (c: Awaited<ReturnType<typeof company>>, nodeId: string | null, host: string, over: object = {}) => {
  const load = { ...idle(), host, hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB, ...over };
  c.app.ctx.hub.report(nodeId ? nodeIdentity(nodeId) : BUILTIN, load);
};
