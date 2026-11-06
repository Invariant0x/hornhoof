import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { expect, it, onTestFinished } from 'vitest';
import { runNode } from '../../node/src/main.js';
import { writeState } from '../../node/src/state.js';
import { claudeProgram, codexProgram } from '../../node/src/terminal/programs.js';
import { Tmux } from '../../node/src/terminal/tmux.js';
import { agents, companies, departments, jobs } from '../src/db/schema.js';
import { as, listen, setUpCompany, testApp, until } from './helpers.js';

/* A stand, not a suite: the real server, two real nodes, real tmux and fake programs, no live CLI. An employee goes from a Claude
   plan to a Codex plan and back. It looks in each node's own tmux for the employee's session. */
const FAKE = new URL('../../node/test/fakes/fake-term.mjs', import.meta.url).pathname;
const FAKE_CODEX = new URL('../../node/test/fakes/fake-codex-term.mjs', import.meta.url).pathname;
const MACHINE = { machineId: 'stand-0001-abcd', hostname: 'stand', os: 'darwin', arch: 'arm64' };
const adapter = { install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [], run: async () => ({ ok: true, sessionId: 's', result: 'ready', output: '', error: null, limits: { status: 'allowed', windows: [] } }) };

async function startNode(server: string, key: string, plan: string, provider: 'claude' | 'codex') {
  const dir = mkdtempSync(join(tmpdir(), `hh-stand-${provider}-`));
  writeState(dir, { server, subscriptionId: plan, provider, key } as never);
  for (const sub of ['home', 'work']) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, 'file'), 'x');
  }
  const socket = `hh-stand-${provider}-${process.pid}`;
  const tmux = new Tmux({ socket, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  const logged: string[] = [];
  const terminal = { tmux, program: provider === 'claude' ? claudeProgram : codexProgram, bin: provider === 'claude' ? FAKE : FAKE_CODEX, home: join(dir, 'home'), plugins: [] };
  const node = await runNode({ dir, adapter: adapter as never, log: (m: unknown) => void logged.push(String(m)), terminal: terminal as never });
  onTestFinished(() => {
    node.stop();
    try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* gone */ }
  });
  return { tmux, logged };
}

it('stand: an employee moves from plan A to plan B and back', async () => {
  const { app, db } = await testApp();
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const server = url.replace('/api/nodes/socket', '').replace(/^ws/, 'http');
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json();
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: connected.command.split('--join ')[1], ...MACHINE } })).json().nodes as { nodeId: string; key: string; subscriptionId: string; provider: string }[];
  const on = (provider: string) => joined.find(node => node.provider === provider)!;
  const A = await startNode(server, on('claude').key, on('claude').subscriptionId, 'claude');
  const B = await startNode(server, on('codex').key, on('codex').subscriptionId, 'codex');
  const [company] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [bruno] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: on('claude').subscriptionId }).returning();
  const session = `a-${bruno!.id}`;
  const state = async () => (await app.inject({ url: `/api/agents/${bruno!.id}/events`, ...as(ceo) })).json().state;
  await until(async () => (await state()).ready, 20_000);
  const moveTo = async (provider: string) => expect((await app.inject({ method: 'PATCH', url: `/api/agents/${bruno!.id}`, payload: { subscription: on(provider).subscriptionId }, ...as(ceo) })).statusCode).toBe(200);
  const lastTurn = async () => (await db.select().from(jobs).where(eq(jobs.agentId, bruno!.id)).orderBy(desc(jobs.createdAt)).limit(1))[0]!;
  const say = async (text: string) => {
    const before = (await lastTurn().catch(() => null))?.id;
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno!.id}/messages`, payload: { text }, ...as(ceo) })).statusCode).toBeLessThan(300);
    await until(async () => (await lastTurn().catch(() => null))?.id !== before, 20_000);
    return lastTurn();
  };
  const finished = (id: string) => until(async () => ['done', 'failed'].includes((await db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status), 40_000);
  const saved = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const look = async (name: string) => {
    const seen = { name, onA: await A.tmux.alive(session), sessionOnA: await A.tmux.has(session), onB: await B.tmux.alive(session), sessionOnB: await B.tmux.has(session), pidA: await A.tmux.programPid(session).catch(() => null), pidB: await B.tmux.programPid(session).catch(() => null) };
    console.log('CASE', JSON.stringify(seen));
    return seen;
  };

  /* 1. Idle on A, moved to B: A has no session, B starts as it does now. */
  const first = await say('first on A');
  await finished(first.id);
  expect(await saved(first.id)).toMatchObject({ status: 'done' });
  expect(await look('1a before the move')).toMatchObject({ onA: true, onB: false });
  await moveTo('codex');
  await until(async () => !(await A.tmux.has(session)), 15_000);
  const onB = await say('first on B');
  await finished(onB.id);
  expect(await saved(onB.id)).toMatchObject({ status: 'done' });
  expect(await look('1b after the move')).toMatchObject({ sessionOnA: false, onB: true });

  /* 2. Moved during a turn on B: it ends with its result first, then B has no session, and A starts. */
  const slow = await say('SLOW work on B');
  await until(async () => (await saved(slow.id)).status === 'running', 15_000);
  await moveTo('claude');
  expect(await look('2a just moved, its turn runs')).toMatchObject({ onB: true });
  await finished(slow.id);
  const ended = await saved(slow.id);
  expect(ended).toMatchObject({ status: 'done', error: null });
  console.log('CASE', JSON.stringify({ name: '2b the turn', status: ended.status, error: ended.error, result: ended.result }));
  await until(async () => !(await B.tmux.has(session)), 15_000);
  const back = await say('back on A');
  await finished(back.id);
  expect(await saved(back.id)).toMatchObject({ status: 'done' });
  expect(await look('2c after it')).toMatchObject({ onA: true, sessionOnB: false });

  /* 3. There and back during a turn on A: the program on A stays, one program, the same process, and B never starts one. */
  const pid = await A.tmux.programPid(session);
  const long = await say('SLOW work on A');
  await until(async () => (await saved(long.id)).status === 'running', 15_000);
  await moveTo('codex');
  await moveTo('claude');
  const next = await say('after coming back');
  await finished(long.id);
  await finished(next.id);
  await new Promise(done => setTimeout(done, 1500));
  const after = await look('3 there and back');
  expect(after).toMatchObject({ onA: true, sessionOnB: false });
  expect(after.pidA).toBe(pid);

  /* 4. A late word after that closes nothing: the node already ran a later turn. */
  console.log('LOG A', JSON.stringify(A.logged.filter(line => line.includes('plan it left') || line.includes('later turn'))));
  console.log('LOG B', JSON.stringify(B.logged.filter(line => line.includes('plan it left') || line.includes('later turn'))));
}, 180_000);
