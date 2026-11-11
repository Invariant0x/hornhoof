import { randomUUID, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
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
  const make = () => new ComputerCarrier({ controlDir, dir, machine: MACHINE, ask, pin: () => over.pin ?? null, trustApp: over.trustApp ?? over.pin === undefined, log: line => lines.push(line), now: () => new Date(now), openEveryMs: 5, closedEveryMs: 50, askMs: 30 });
  const alive = () => writeFileSync(join(controlDir, 'alive'), '');
  const settings = () => JSON.parse(readFileSync(join(controlDir, 'computer.json'), 'utf8')) as { untilSec: number | null; until: string | null; asked: null; by: string };
  const files = () => (existsSync(join(controlDir, 'computer')) ? readdirSync(join(controlDir, 'computer')).sort() : []);
  const put = (name: string, content: object | string = '') => {
    mkdirSync(join(controlDir, 'computer'), { recursive: true });
    writeFileSync(join(controlDir, 'computer', name), typeof content === 'string' ? content : JSON.stringify(content));
  };
  return { controlDir, dir, asked, said, lines, make, alive, settings, files, put, advance: (ms: number) => void (now += ms), nowS: () => Math.floor(now / 1000) };
}

const CLOSED = { untilSec: null, until: null, asked: null, by: 'keeper' };

describe("a machine's keeper and its computer access", () => {
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
    expect(s.asked[0]).toMatchObject({ method: 'GET', path: '/api/network/computer?updater=1&held=' });
    expect(s.settings()).toEqual({ untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: null, by: 'keeper' });
    expect(s.files()).toEqual([`${id}.json`]);
    expect(JSON.parse(readFileSync(join(s.controlDir, 'computer', `${id}.json`), 'utf8'))).toEqual({ id, command: 'uname -a', timeout: 30 });
    /* It names what it holds from then on, and posts the updater's answer, after which both files go. */
    s.said.get = open(until_);
    s.put(`${id}.out.json`, { id, exit: 3, output: 'Linux\n' });
    await carrier.tick();
    expect(s.asked.at(-2)).toMatchObject({ method: 'GET', path: `/api/network/computer?updater=1&held=${id}` });
    expect(s.asked.at(-1)).toEqual({ method: 'POST', path: `/api/network/computer/${id}`, body: { exit: 3, output: 'Linux\n' } });
    expect(s.files()).toEqual([]);
  });

  it('says when its updater is not alive', async () => {
    const s = stand();
    const carrier = s.make();
    carrier.prepare();
    await carrier.tick();
    expect(s.asked[0]!.path).toBe('/api/network/computer?updater=0&held=');
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
    writeFileSync(join(s.controlDir, 'computer.json'), JSON.stringify({ untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: null, by: 'keeper' }));
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

  it("moves an older app's file aside, once", async () => {
    const s = stand();
    const until_ = s.nowS() + 3600;
    const old = { untilSec: until_, until: new Date(until_ * 1000).toISOString(), asked: { reason: 'Look.', at: '2026-11-10T09:00:00.000Z' } };
    writeFileSync(join(s.controlDir, 'computer.json'), JSON.stringify(old));
    s.make().prepare();
    expect(JSON.parse(readFileSync(join(s.controlDir, 'computer.legacy.json'), 'utf8'))).toEqual(old);
    expect(s.settings()).toEqual(CLOSED);
    /* What was set aside already is never written over. */
    writeFileSync(join(s.controlDir, 'computer.json'), JSON.stringify({ untilSec: null, until: null, asked: null }));
    s.make().prepare();
    expect(JSON.parse(readFileSync(join(s.controlDir, 'computer.legacy.json'), 'utf8'))).toEqual(old);
    expect(s.settings()).toEqual(CLOSED);
  });

  it('stops without a late write, and closed', async () => {
    const s = stand();
    let answer!: (said: { status: number; body: unknown }) => void;
    const held = new Promise<{ status: number; body: unknown }>(resolve => (answer = resolve));
    const id = randomUUID();
    const carrier = new ComputerCarrier({ controlDir: s.controlDir, dir: s.dir, machine: MACHINE, ask: method => (method === 'GET' ? held : Promise.resolve({ status: 204, body: null })), pin: () => null, trustApp: true, log: () => undefined, now: () => new Date(START) });
    carrier.prepare();
    const round = carrier.tick();
    const stopping = carrier.stop();
    /* The app's answer comes after the stop: open, with a command. */
    answer(open(Math.floor(START / 1000) + 3600, null, [{ id, command: 'true', timeout: 30 }]));
    await Promise.all([round, stopping]);
    expect(s.files()).toEqual([]);
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
