import { randomUUID, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Grant } from '../src/modules/computer/grant.js';
import { ComputerCarrier, GRANTS_FILE, type ComputerAsk } from '../src/modules/keeper/computer.js';
import { until } from './helpers-basic.js';

const { subtle } = webcrypto;
const b64 = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const MACHINE = 'a'.repeat(64);
const START = Date.parse('2026-11-10T10:00:00.000Z');
const DAY_S = 24 * 3600;

/* A person's key as their browser makes it, and a grant they sign for this machine. */
async function owner(nowMs = START) {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64(await subtle.exportKey('spki', pair.publicKey));
  const grant = async (over: Record<string, unknown> = {}): Promise<Grant> => {
    const at = Math.floor(nowMs / 1000);
    const payload = JSON.stringify({ v: 1, machine: MACHINE, until: at + DAY_S, at, nonce: b64(webcrypto.getRandomValues(new Uint8Array(16))), ...over });
    return { payload, signature: b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload))) };
  };
  return { publicKey, grant };
}

type Answer = { status: number; body: unknown } | Error | 'never';
const open = (untilSec: number, grant: Grant | null = null, runs: object[] = []) => ({ status: 200, body: { access: { untilSec, until: new Date(untilSec * 1000).toISOString(), grant }, runs } });
const closed = (runs: object[] = []) => ({ status: 200, body: { access: null, runs } });

/* A machine's control folder and its keeper's own, with an app that answers what the test says and a clock the test
   moves. */
function stand(over: { pin?: string | null; trustApp?: boolean } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-'));
  const computerControl = join(dir, 'computer-control');
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const said = { get: closed() as Answer, post: { status: 204, body: null } as Answer };
  let now = START;
  const lines: string[] = [];
  const ask: ComputerAsk = (method, path, body, signal) => {
    asked.push({ method, path, body });
    const answer = method === 'GET' ? said.get : said.post;
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer !== 'never') return Promise.resolve(answer);
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const make = () => new ComputerCarrier({ dir, machine: MACHINE, ask, pin: () => over.pin ?? null, trustApp: over.trustApp ?? over.pin === undefined, log: line => lines.push(line), now: () => new Date(now), openEveryMs: 5, closedEveryMs: 50, askMs: 30 });
  const alive = () => {
    mkdirSync(computerControl, { recursive: true });
    const heartbeat = join(computerControl, 'alive');
    writeFileSync(heartbeat, '');
    utimesSync(heartbeat, new Date(now), new Date(now));
  };
  const settings = () => JSON.parse(readFileSync(join(computerControl, 'computer.json'), 'utf8')) as { untilSec: number | null; until: string | null; asked: null; by: string };
  const files = () => (existsSync(join(computerControl, 'computer')) ? readdirSync(join(computerControl, 'computer')).sort() : []);
  const put = (name: string, content: object | string = '') => {
    mkdirSync(join(computerControl, 'computer'), { recursive: true });
    writeFileSync(join(computerControl, 'computer', name), typeof content === 'string' ? content : JSON.stringify(content));
  };
  return { controlDir, dir, computerControl, asked, said, lines, make, alive, settings, files, put, advance: (ms: number) => void (now += ms), nowS: () => Math.floor(now / 1000) };
}

const CLOSED = { untilSec: null, until: null, asked: null, by: 'keeper' };

describe("a machine's keeper and its computer access", () => {
  it('takes standing access from its company leader even with a pinned owner key', async () => {
    const s = stand({ pin: (await owner()).publicKey });
    const carrier = s.make();
    carrier.prepare();
    const id = randomUUID();
    s.said.get = { status: 200, body: { access: { standing: true }, runs: [{ id, command: 'recorded sample', timeout: 30 }] } };
    await carrier.tick();
    expect(s.files()).toEqual([`${id}.json`]);
    expect(s.settings().untilSec).toBeGreaterThan(s.nowS());
    s.advance(30 * DAY_S * 1000);
    await carrier.tick();
    expect(s.settings().untilSec).toBeGreaterThan(s.nowS());
    s.said.get = closed();
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
  });

  it('writes the access and the commands for its updater, and brings the answers back', async () => {
    const s = stand();
    s.alive();
    const carrier = s.make();
    carrier.prepare();
    expect(s.settings()).toEqual(CLOSED);
    const id = randomUUID();
    const until_ = s.nowS() + 3600;
    s.said.get = open(until_, null, [{ id, command: 'uname -a', timeout: 30 }]);
    await carrier.tick();
    expect(s.asked[0]).toMatchObject({ method: 'GET', path: '/api/network/computer?standing=1&updater=1&held=' });
    expect(s.settings()).toEqual({ untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: null, by: 'keeper' });
    expect(s.files()).toEqual([`${id}.json`]);
    expect(JSON.parse(readFileSync(join(s.computerControl, 'computer', `${id}.json`), 'utf8'))).toEqual({ id, command: 'uname -a', timeout: 30 });
    /* It names what it holds from then on, and posts the updater's answer, after which both files go. */
    s.said.get = open(until_);
    s.put(`${id}.out.json`, { id, exit: 3, output: 'Linux\n' });
    await carrier.tick();
    expect(s.asked.at(-2)).toMatchObject({ method: 'GET', path: `/api/network/computer?standing=1&updater=1&held=${id}` });
    expect(s.asked.at(-1)).toEqual({ method: 'POST', path: `/api/network/computer/${id}`, body: { exit: 3, output: 'Linux\n' } });
    expect(s.files()).toEqual([]);
  });

  it('says when its updater is not alive', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    await carrier.tick();
    expect(s.asked[0]!.path).toBe('/api/network/computer?standing=1&updater=0&held=');
  });

  it('takes updater liveness only from the private heartbeat and only while it is fresh', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    onTestFinished(() => { clock.mockRestore(); });
    const shared = join(s.controlDir, 'alive');
    writeFileSync(shared, '');
    utimesSync(shared, new Date(START), new Date(START));
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=0&');
    s.alive();
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=1&');
    s.advance(30_000);
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=0&');
  });

  it('takes no heartbeat that is a link, even to a fresh file', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    s.alive();
    const fresh = join(s.dir, 'fresh-heartbeat');
    renameSync(join(s.computerControl, 'alive'), fresh);
    symlinkSync(fresh, join(s.computerControl, 'alive'));
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=0&');
  });

  it('keeps a heartbeat alive after a backward clock step of up to five seconds', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    s.alive();
    s.advance(-5_000);
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=1&');
    s.advance(-1);
    await carrier.tick();
    expect(s.asked.at(-1)?.path).toContain('&updater=0&');
  });

  it('closes on a refusal, and when it hears nothing for a minute', async () => {
    for (const silence of [new Error('socket hang up'), { status: 503, body: null }, 'never'] as Answer[]) {
      const s = stand();
      const carrier = s.make();
      carrier.prepare();
      const until_ = s.nowS() + 3600;
      s.said.get = open(until_);
      await carrier.tick();
      expect(s.settings().untilSec).toBe(until_);
      s.said.get = silence;
      s.advance(59_000);
      await carrier.tick();
      expect(s.settings().untilSec, String(silence)).toBe(until_);
      s.advance(2_000);
      await carrier.tick();
      expect(s.settings(), String(silence)).toEqual(CLOSED);
    }
    /* An app from before access was per machine knows no such route. */
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    s.said.get = open(s.nowS() + 3600);
    await carrier.tick();
    s.said.get = { status: 404, body: null };
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
  });

  it('closes what it wrote before a restart, once it has heard nothing for a minute', async () => {
    const s = stand();
    const until_ = s.nowS() + 3600;
    mkdirSync(s.computerControl);
    writeFileSync(join(s.computerControl, 'computer.json'), JSON.stringify({ untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: null, by: 'keeper' }));
    const carrier = s.make();
    carrier.prepare();
    /* A restart stops no command: what the keeper wrote before stays. */
    expect(s.settings().untilSec).toBe(until_);
    s.said.get = new Error('no app');
    s.said.post = 'never';
    const id = randomUUID();
    s.put(`${id}.json`, { id, command: 'true', timeout: 30 });
    s.put(`${id}.out.json`, { id, exit: 0, output: '' });
    s.advance(61_000);
    /* An answer that cannot be posted does not hold the closing back. */
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    expect(s.files()).toEqual([`${id}.json`, `${id}.out.json`]);
  });

  it("opens only on its owner's grant, and never twice on one", async () => {
    const mine = await owner();
    const other = await owner();
    const s = stand({ pin: mine.publicKey });
    const carrier = s.make();
    carrier.prepare();
    const until_ = s.nowS() + 3600;
    const refused: [string, Grant | null][] = [
      ['no grant', null],
      ["another key's", await other.grant()],
      ["another machine's", await mine.grant({ machine: 'b'.repeat(64) })],
      ['one past its end', await mine.grant({ at: s.nowS() - 7200, until: s.nowS() - 3600 })],
      ['one longer than a day', await mine.grant({ until: s.nowS() + 2 * DAY_S })],
    ];
    for (const [name, grant] of refused) {
      s.said.get = open(until_, grant);
      await carrier.tick();
      expect(s.settings(), name).toEqual(CLOSED);
    }
    expect(s.lines.filter(line => line.includes('no grant of its owner'))).toHaveLength(1);

    /* Open until the earlier of what its owner signed and what the app says. */
    const grant = await mine.grant();
    s.said.get = open(until_, grant);
    await carrier.tick();
    expect(s.settings().untilSec).toBe(until_);
    s.said.get = open(s.nowS() + 2 * DAY_S, grant);
    await carrier.tick();
    expect(s.settings().untilSec).toBe(s.nowS() + DAY_S);
    /* Closed by the app, the same grant sent again opens nothing: here, and after a restart on the same folder. */
    s.said.get = closed();
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    s.said.get = open(until_, grant);
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    const again = s.make();
    again.prepare();
    await again.tick();
    expect(s.settings()).toEqual(CLOSED);
    expect((JSON.parse(readFileSync(join(s.dir, GRANTS_FILE), 'utf8')) as { spent: unknown[] }).spent).toHaveLength(1);
    /* A new one opens it again; another grant in its place spends the one before. */
    const next = await mine.grant();
    s.said.get = open(until_, next);
    await again.tick();
    expect(s.settings().untilSec).toBe(until_);
    s.said.get = open(until_, await mine.grant());
    await again.tick();
    s.said.get = open(until_, next);
    await again.tick();
    expect(s.settings()).toEqual(CLOSED);
    /* What is spent is kept only until its own end. */
    s.advance((DAY_S + 600) * 1000);
    s.said.get = closed();
    await again.tick();
    expect((JSON.parse(readFileSync(join(s.dir, GRANTS_FILE), 'utf8')) as { spent: unknown[] }).spent).toEqual([]);
  });

  it('opens nothing on a worker that holds no key, and takes its app at its word on the server alone', async () => {
    const worker = stand({ pin: null, trustApp: false });
    const carrier = worker.make();
    carrier.prepare();
    worker.said.get = open(worker.nowS() + 3600, await (await owner()).grant());
    await carrier.tick();
    expect(worker.settings()).toEqual(CLOSED);

    const server = stand({ pin: null, trustApp: true });
    const own = server.make();
    own.prepare();
    const until_ = server.nowS() + 3600;
    server.said.get = open(until_);
    await own.tick();
    expect(server.settings().untilSec).toBe(until_);
  });

  it('starts closed and leaves the old shared window and requests in place on update', async () => {
    const s = stand();
    const until_ = s.nowS() + 3600;
    const old = { untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: null, by: 'keeper' };
    const id = randomUUID();
    const shared = join(s.controlDir, 'computer');
    mkdirSync(shared);
    writeFileSync(join(s.controlDir, 'computer.json'), JSON.stringify(old));
    writeFileSync(join(shared, `${id}.json`), '{}');
    const carrier = s.make();
    carrier.prepare();
    expect(s.settings()).toEqual(CLOSED);
    expect(s.files()).toEqual([]);
    s.said.get = { status: 200, body: { access: { standing: true }, runs: [] } };
    await carrier.tick();
    expect(s.settings().untilSec).toBeGreaterThan(s.nowS());
    expect(s.asked[0]!.path).toContain('&held=');
    expect(s.asked[0]!.path).not.toContain(id);
    expect(JSON.parse(readFileSync(join(s.controlDir, 'computer.json'), 'utf8'))).toEqual(old);
    expect(readdirSync(shared)).toEqual([`${id}.json`]);
  });

  it('stops without a late write, and closed', async () => {
    const s = stand();
    let answer!: (said: { status: number; body: unknown }) => void;
    const held = new Promise<{ status: number; body: unknown }>(resolve => (answer = resolve));
    const id = randomUUID();
    const carrier = new ComputerCarrier({ dir: s.dir, machine: MACHINE, ask: method => (method === 'GET' ? held : Promise.resolve({ status: 204, body: null })), pin: () => null, trustApp: true, log: () => undefined, now: () => new Date(START) });
    carrier.prepare();
    const round = carrier.tick();
    const stopping = carrier.stop();
    /* The app's answer comes after the stop: open, with a command. */
    answer(open(Math.floor(START / 1000) + 3600, null, [{ id, command: 'true', timeout: 30 }]));
    await Promise.all([round, stopping]);
    expect(s.files()).toEqual([]);
    /* Closed, and said to be closed by a keeper that stopped: its updater lets a command already under way run on
       until a keeper speaks again, as one that recreates the keeper would otherwise end itself halfway. */
    expect(s.settings()).toEqual({ ...CLOSED, stopped: true });
  });

  it('keeps the word of a keeper that stopped until it hears the app, and then says open or closed as ever', async () => {
    const s = stand();
    const before = s.make();
    before.prepare();
    s.said.get = { status: 200, body: { access: { standing: true }, runs: [] } };
    await before.tick();
    await before.stop();
    expect(s.settings()).toEqual({ ...CLOSED, stopped: true });
    /* The keeper of the same machine started again: nothing it said yet, so the stopped one's word stands. */
    const after = s.make();
    after.prepare();
    expect(s.settings()).toEqual({ ...CLOSED, stopped: true });
    await after.tick();
    expect(s.settings().untilSec).toBeGreaterThan(s.nowS());
    expect(s.settings()).not.toHaveProperty('stopped');
    s.said.get = closed();
    await after.tick();
    expect(s.settings()).toEqual(CLOSED);
    /* One that cannot hear the app for its minute closes as ever: no command runs on past that. */
    await after.stop();
    const deaf = s.make();
    deaf.prepare();
    s.said.get = { status: 503, body: null };
    s.advance(61_000);
    await deaf.tick();
    expect(s.settings()).toEqual(CLOSED);
  });

  it('writes each command once, and removes one only after its answer was taken', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    const until_ = s.nowS() + 3600;
    const [started, answered, fresh] = [randomUUID(), randomUUID(), randomUUID()];
    s.put(`${started}.started`);
    s.put(`${answered}.out.json`, { id: answered, exit: 0, output: 'done' });
    s.said.post = { status: 503, body: null };
    s.said.get = open(until_, null, [started, answered, fresh].map(id => ({ id, command: 'true', timeout: 30 })));
    await carrier.tick();
    /* Neither the one its updater began nor the one already answered is written again. */
    expect(s.files()).toEqual([`${answered}.out.json`, `${fresh}.json`, `${started}.started`].sort());
    /* An answer the app could not take stays for the next round; one it took, or knows nothing of, goes. */
    s.said.get = open(until_);
    s.said.post = { status: 404, body: null };
    await carrier.tick();
    expect(s.files()).toEqual([`${fresh}.json`, `${started}.started`].sort());
    /* A command with no answer yet is never removed. */
    await carrier.tick();
    expect(s.files()).toContain(`${fresh}.json`);
    /* What is no command's file is left alone. */
    s.put('notes.out.json', { exit: 0, output: '' });
    await carrier.tick();
    expect(s.asked.filter(call => call.method === 'POST')).toHaveLength(2);
  });

  it('lets go of what the app no longer has out, and of an answer nobody can read', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    const until_ = s.nowS() + 3600;
    const [gone, broken, kept] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [gone, broken, kept]) s.put(`${id}.json`, { id, command: 'true', timeout: 30 });
    s.put(`${gone}.started`);
    /* An answer the updater could not write whole: it is moved into place all the same, and stays unreadable. */
    s.put(`${broken}.out.json`, '');
    s.said.get = { status: 200, body: { ...open(until_).body, forget: [gone] } };
    await carrier.tick();
    /* Its updater stops what it began once the command's file is gone, and clears its own mark. */
    expect(s.files()).toEqual([`${gone}.started`, `${kept}.json`].sort());
    expect(s.asked.filter(call => call.method === 'POST')).toEqual([]);
    expect(s.lines.filter(line => line.includes('could not be read'))).toHaveLength(1);
  });

  it('posts output at the limit and lets go of a longer answer', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    const [atLimit, overLimit] = [randomUUID(), randomUUID()];
    const output = 'a'.repeat(30_000);
    for (const [id, text] of [[atLimit, output], [overLimit, output + 'a']] as const) {
      s.put(`${id}.json`, { id, command: 'recorded sample', timeout: 30 });
      s.put(`${id}.out.json`, { id, exit: 0, output: text });
    }
    await carrier.tick();
    expect(s.asked.filter(call => call.method === 'POST').map(call => call.path)).toEqual([`/api/network/computer/${atLimit}`]);
    expect(s.asked.find(call => call.method === 'POST')?.body).toEqual({ exit: 0, output });
    expect(s.files()).toEqual([]);
  });

  it('says so when it did not take the grant it was given', async () => {
    const mine = await owner();
    const s = stand({ pin: mine.publicKey });
    const carrier = s.make();
    carrier.prepare();
    const gets = () => s.asked.filter(call => call.method === 'GET').map(call => call.path);
    await carrier.tick();
    const notMine = await (await owner()).grant();
    s.said.get = open(s.nowS() + 3600, notMine);
    await carrier.tick();
    /* The round after: the app hears that this machine stayed closed, once, and which grant it was that opened
       nothing, so a grant the owner signed since is not closed for it. */
    s.said.get = closed();
    await carrier.tick();
    await carrier.tick();
    const nonce = (JSON.parse(notMine.payload) as { nonce: string }).nonce;
    expect(gets().map(path => path.includes(`refused=${nonce}`))).toEqual([false, false, true, false]);
    expect(gets().filter(path => path.includes('refused='))).toHaveLength(1);
    /* A grant it took, and an answer that was closed, are nothing to say. */
    s.said.get = open(s.nowS() + 3600, await mine.grant());
    await carrier.tick();
    await carrier.tick();
    expect(gets().slice(-1)[0]).not.toContain('refused=');
    /* An open answer with no grant at all is refused too, with nothing to name. */
    s.said.get = open(s.nowS() + 3600, null);
    await carrier.tick();
    await carrier.tick();
    expect(gets().slice(-1)[0]).toContain('refused=1');
  });

  it('starts its record of grants anew when it cannot be read, and takes no grant signed before that', async () => {
    const mine = await owner();
    const s = stand({ pin: mine.publicKey });
    /* What a power cut or a build with another shape left. */
    writeFileSync(join(s.dir, GRANTS_FILE), '{"held": nul');
    const carrier = s.make();
    carrier.prepare();
    /* A grant signed a while ago, which this keeper may have taken and seen end before: it can no longer tell, so it
       does not take it. */
    const until_ = s.nowS() + 3600;
    s.said.get = open(until_, await mine.grant({ at: s.nowS() - 60 }));
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    expect(s.lines.filter(line => line.includes('starts a new one'))).toHaveLength(1);
    /* One its owner signs now opens the machine, once. */
    const fresh = await mine.grant();
    s.said.get = open(until_, fresh);
    await carrier.tick();
    expect(s.settings().untilSec).toBe(until_);
    s.said.get = closed();
    await carrier.tick();
    s.said.get = open(until_, fresh);
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    /* The new record is kept, and a keeper that starts again goes by it. */
    const kept = JSON.parse(readFileSync(join(s.dir, GRANTS_FILE), 'utf8')) as { since: number; spent: unknown[] };
    expect([kept.since, kept.spent.length]).toEqual([s.nowS(), 1]);
    const again = s.make();
    again.prepare();
    s.said.get = open(until_, await mine.grant({ at: s.nowS() - 60 }));
    await again.tick();
    expect(s.settings()).toEqual(CLOSED);
  });

  it('closes when it cannot write down what it spent, and still opens nothing twice', async () => {
    const mine = await owner();
    const s = stand({ pin: mine.publicKey });
    const carrier = s.make();
    carrier.prepare();
    const until_ = s.nowS() + 3600;
    const grant = await mine.grant();
    s.said.get = open(until_, grant);
    await carrier.tick();
    expect(s.settings().untilSec).toBe(until_);
    /* The keeper's folder takes no write: a folder stands where the file goes. */
    rmSync(join(s.dir, GRANTS_FILE));
    mkdirSync(join(s.dir, GRANTS_FILE, 'taken'), { recursive: true });
    s.said.get = closed();
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    /* The same grant sent again opens nothing, though nothing could be written of its end. */
    s.said.get = open(until_, grant);
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    /* A new grant opens nothing either while what it holds cannot be kept: it could not be told from a spent one later. */
    s.said.get = open(until_, await mine.grant());
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
    expect(s.lines.filter(line => line.includes('could not keep'))).toHaveLength(1);
    /* Once the folder takes writes again, it does. */
    rmSync(join(s.dir, GRANTS_FILE), { recursive: true });
    const fresh = await mine.grant();
    s.said.get = open(until_, fresh);
    await carrier.tick();
    expect(s.settings().untilSec).toBe(until_);
    s.said.get = open(until_, grant);
    await carrier.tick();
    expect(s.settings()).toEqual(CLOSED);
  });

  it('asks often only while access is open or a command is out', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    /* What a round answers is the pause before the next. */
    expect(await carrier.tick()).toBe(50);
    s.said.get = open(s.nowS() + 3600);
    expect(await carrier.tick()).toBe(5);
    s.said.get = closed();
    expect(await carrier.tick()).toBe(50);
    s.put(`${randomUUID()}.json`, { command: 'true' });
    expect(await carrier.tick()).toBe(5);
    /* Started, it goes on by itself. */
    const gets = () => s.asked.filter(call => call.method === 'GET').length;
    const before = gets();
    onTestFinished(() => carrier.stop());
    carrier.start();
    await until(() => gets() >= before + 3);
  });
});
