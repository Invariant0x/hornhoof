import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished } from 'vitest';
import WebSocket from 'ws';
import { runNode } from '../../node/src/main.js';
import { Tmux } from '../../node/src/terminal/tmux.js';
import { claudeProgram } from '../../node/src/terminal/programs.js';
import { writeState } from '../../node/src/state.js';
import { jobs, people, subscriptions } from '../src/db/schema.js';
import { as, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const FAKE = new URL('../../node/test/fakes/stand-428.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const said = (name: string, what: unknown) => console.log('CASE', name, JSON.stringify(what));

type Screen = { ws: WebSocket; text: () => string; ready: () => unknown; refused: () => string[]; closed: Promise<{ code: number; reason: string }> };
type Away = { status: number; reason?: string };
type Answer = { line: string; result: string; fetched: { path?: string; base64?: string; error?: string } | null };

it('a real server, node and tmux: the CEO writes in a terminal on the plan of Lisa, and only she steers it', async () => {
  const socket = `hh-stand428-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), 'hh-stand428-'));
  const out = join(dir, 'answers.jsonl');
  const keysLog = `${out}.keys`;
  writeFileSync(out, '');
  writeFileSync(keysLog, '');
  process.env.STAND_OUT = out;
  const { app, db } = await testApp({ NODE_KEY, STREAM_PING_MS: '300' });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const server = url.replace('/api/nodes/socket', '').replace(/^ws/, 'http');
  writeState(dir, { server, subscriptionId: 's1', provider: 'claude', key: NODE_KEY } as never);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const tmux = new Tmux({ socket, env: { PATH: process.env.PATH ?? '', HOME: dir, STAND_OUT: out } });
  const adapter = { install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [], run: async () => ({ ok: true, sessionId: 's', result: 'ready', output: '', error: null, limits: { status: 'allowed', windows: [] } }) };
  const node = await runNode({ dir, adapter: adapter as never, log: () => {}, terminal: { tmux, program: claudeProgram, bin: FAKE, home: join(dir, 'home'), plugins: [] } });
  onTestFinished(async () => { node.stop(); try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* gone */ } });
  const state = async (token = ceo) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
  await until(async () => { const s = await state(); return s.ready && s.terminal; }, 15_000);

  const lisa = await invitePerson(app, ceo, { name: 'Lisa', email: 'lisa@example.com', access: { whole: true } });
  const uma = await invitePerson(app, ceo, { name: 'Uma', email: 'uma@example.com', access: { whole: true } });
  const idOf = async (name: string) => (await db.select().from(people).where(eq(people.name, name)))[0]!.id;
  const lisaId = await idOf('Lisa');
  const ceoId = (await db.select().from(people).where(eq(people.isOwner, true)))[0]!.id;
  await db.update(subscriptions).set({ ownerPersonId: lisaId });
  const names = new Map([[lisaId, 'Lisa'], [ceoId, 'CEO']]);

  const open = (token: string): Promise<Screen | Away> => new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', '/api/agents/orchestrator/terminal?cols=100&rows=30'), { headers: { cookie: `hh_session=${token}` } });
    let text = '';
    let ready: unknown = null;
    const refused: string[] = [];
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.type === 'data') text += m.data;
      if (m.type === 'ready') ready = m;
      if (m.type === 'refused') refused.push(m.reason);
    });
    const closed = new Promise<{ code: number; reason: string }>(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.on('unexpected-response', (_q, res) => { let body = ''; res.on('data', c => { body += String(c); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, reason: JSON.parse(body || '{}').error?.reason })); });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, text: () => text, ready: () => ready, refused: () => refused, closed }));
  });
  const view = async (token: string) => { const v = await open(token); if ('status' in v) throw new Error(`Turned away ${v.status}`); return v; };
  const type = (v: Screen, data: string, more: object = {}) => v.ws.send(JSON.stringify({ type: 'input', data, ...more }));
  const answers = () => readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Answer);
  const answered = (line: string) => until(() => answers().some(a => a.line === line), 30_000);
  const keys = () => readFileSync(keysLog, 'utf8').trim().split('\n').filter(Boolean);
  const turnOf = async (line: string) => {
    let found: { createdBy: string | null; status: string; prompt: string } | undefined;
    await until(async () => {
      found = (await db.select({ createdBy: jobs.createdBy, status: jobs.status, prompt: jobs.prompt }).from(jobs)).find(j => j.prompt.includes(line));
      return found !== undefined && found.status !== 'running' && found.status !== 'queued';
    }, 30_000);
    return { by: names.get(found!.createdBy ?? '') ?? found!.createdBy, status: found!.status };
  };
  const idle = () => until(async () => !(await state()).busy, 30_000);

  /* 1. Rights as the window hears them, from what the server knows. */
  const ceoView = await view(ceo);
  await until(() => ceoView.text().includes('❯'), 15_000);
  await until(() => ceoView.ready() !== null, 5000);
  said('CEO opens the terminal on the plan of Lisa', { ready: ceoView.ready() });
  expect(ceoView.ready()).toEqual({ type: 'ready', write: false, message: true });
  const away = await open(uma);
  said('someone else on another plan', { refused: away });
  expect(away).toEqual({ status: 403, reason: 'agent_hidden' });

  /* 2. No key that steers gets through, by any way of sending it, nor with rights the frame claims. */
  const steering: [string, string][] = [['Escape', '\x1b'], ['Ctrl+C', '\x03'], ['/login', '/login\r'], ['!rm', '!rm -rf x\r'], ['pasted /login', paste('/login')], ['/ key by key', '/'], ['the rest of it', 'login'], ['its Enter', '\r']];
  for (const [what, data] of steering) type(ceoView, data, { write: true, sender: lisaId });
  await until(() => ceoView.refused().length >= steering.length - 1, 5000);
  await sleep(800);
  said('CEO steers', { refused: ceoView.refused(), programHeard: keys(), answers: answers().length, screenShows: /login|rm -rf/.test(ceoView.text()) });
  expect(ceoView.refused()).toEqual(Array(steering.length - 1).fill('control'));
  expect(keys()).toEqual([]);
  expect(answers()).toEqual([]);
  expect(ceoView.text()).not.toMatch(/login|rm -rf/);

  /* 3. Words and Enter open a turn that is the CEO's, with the tools of that turn. */
  type(ceoView, 'question of the CEO\r');
  await answered('question of the CEO');
  const first = answers().find(a => a.line === 'question of the CEO')!;
  const firstTurn = await turnOf('question of the CEO');
  said('CEO writes', { turn: firstTurn, tool: first.result.slice(0, 60) });
  expect(firstTurn).toEqual({ by: 'CEO', status: 'done' });
  expect(first.result).toMatch(/^200 /);
  await idle();

  /* 4. A picture on the terminal: uploaded, then the browser inserts its line, and the agent gets its bytes in that turn. */
  const up = await app.inject({ method: 'POST', url: '/api/agents/orchestrator/pictures?name=screen.png', headers: { 'content-type': 'image/png' }, payload: PNG, ...as(ceo) });
  expect(up.statusCode).toBe(201);
  const picture = up.json() as { id: string; name: string; insert?: string };
  const line = picture.insert ?? `${picture.name}: hh-fetch message ${picture.id}`;
  type(ceoView, line);
  await sleep(300);
  type(ceoView, '\r');
  await answered(line);
  const got = answers().find(a => a.line === line)!;
  const pictureTurn = await turnOf(line);
  said('CEO sends a picture', { inserted: line, fetched: got.fetched?.path, error: got.fetched?.error, sameBytes: got.fetched?.base64 === PNG.toString('base64'), turn: pictureTurn });
  expect(got.fetched?.base64).toBe(PNG.toString('base64'));
  expect(pictureTurn).toEqual({ by: 'CEO', status: 'done' });
  await idle();

  /* 5. At the end of a turn: Lisa's turn runs, the CEO presses Enter in it, and what he wrote is his own turn after it. */
  const owner = await view(lisa);
  await until(() => owner.ready() !== null, 5000);
  expect(owner.ready()).toEqual({ type: 'ready', write: true, message: true });
  type(owner, 'SLOW turn of Lisa\r');
  await until(async () => (await state()).busy, 20_000);
  type(ceoView, 'and the limits\r');
  await answered('SLOW turn of Lisa');
  await answered('and the limits');
  const hers = await turnOf('SLOW turn of Lisa');
  const his = await turnOf('and the limits');
  said('end of a turn', { hers, his });
  expect(hers).toEqual({ by: 'Lisa', status: 'done' });
  expect(his).toEqual({ by: 'CEO', status: 'done' });
  await idle();

  /* 6. The owner of the plan steers it: Escape reaches the program, and / goes in. */
  type(owner, '\x1b');
  await until(() => keys().includes('ESC'), 5000);
  type(owner, '/help\r');
  await answered('/help');
  said('Lisa steers', { programHeard: keys(), slash: answers().some(a => a.line === '/help') });
  await idle();

  /* 7. She loses the plan while her window is open: it closes, and she gets no control back by opening it again. */
  await db.update(subscriptions).set({ ownerPersonId: await idOf('Uma') });
  app.ctx.bus.accessChanged((await db.select().from(people).where(eq(people.id, lisaId)))[0]!.companyId);
  const closed = await owner.closed;
  const again = await open(lisa);
  said('Lisa loses the plan', { closed, again: 'status' in again ? again : (again as Screen).ready() });
  expect(closed.code).toBe(4403);
  expect(again).toEqual({ status: 403, reason: 'agent_hidden' });
}, 180_000);
