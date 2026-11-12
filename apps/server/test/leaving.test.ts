import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { COPY_STATE } from '../src/modules/keeper/copy.js';
import { Leaving } from '../src/modules/keeper/leave.js';
import { RETRY_UPLOAD_MS, UPLOAD_AGAIN_MS, UPLOAD_FILE, UPLOADS_DIR, WIPE_FILE, WIPED_FILE } from '../src/modules/keeper/uploads.js';

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-leaving-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The keeper of a machine whose owner lost the scope, with a clock the test moves, and the updater and the leader played
   by the test. */
function stand() {
  const controlDir = folder();
  const dir = folder();
  const lines: string[] = [];
  const state = { now: 0, halts: 0, haltFails: false, answer: 201 as number | Error, puts: [] as { id: string; bytes: string; length: number }[], server: 'https://acme.hornhoof.test' as string | null };
  const leaving = new Leaving({
    controlDir,
    dir,
    halt: async () => {
      state.halts += 1;
      if (state.haltFails) throw new Error('the database does not answer');
    },
    put: async (id, file, length) => {
      state.puts.push({ id, bytes: readFileSync(file, 'utf8'), length });
      if (state.answer instanceof Error) throw state.answer;
      return state.answer;
    },
    server: () => state.server,
    log: line => lines.push(line),
    clock: () => state.now,
  });
  const asked = () => (existsSync(join(controlDir, UPLOAD_FILE)) ? (JSON.parse(readFileSync(join(controlDir, UPLOAD_FILE), 'utf8')) as { id: string }).id : null);
  const uploads = () => (existsSync(join(controlDir, UPLOADS_DIR)) ? readdirSync(join(controlDir, UPLOADS_DIR)).sort() : []);
  /* The updater answers the request there is: with the packed file, or with a line why not. */
  const updater = (ok = true) => {
    const id = asked()!;
    mkdirSync(join(controlDir, UPLOADS_DIR), { recursive: true });
    if (ok) writeFileSync(join(controlDir, UPLOADS_DIR, `${id}.tar.gz`), `rows of ${id}`);
    writeFileSync(join(controlDir, UPLOADS_DIR, `${id}.${ok ? 'done' : 'failed'}`), ok ? '' : 'A table could not be read.\n');
    rmSync(join(controlDir, UPLOAD_FILE));
    return id;
  };
  return { controlDir, dir, lines, state, leaving, asked, uploads, updater, later: (ms: number) => void (state.now += ms) };
}

describe('the keeper of a machine that stops holding the data', () => {
  it('stops its copy before anything else', async () => {
    const s = stand();
    s.state.haltFails = true;
    await s.leaving.step('waiting');
    await s.leaving.step('wipe');
    /* A copy that could not be stopped is neither read nor wiped. */
    expect([s.asked(), existsSync(join(s.controlDir, WIPE_FILE)), s.state.halts]).toEqual([null, false, 2]);
    expect(s.lines).toEqual(["Could not stop this machine's copy yet: the database does not answer"]);
    s.state.haltFails = false;
    await s.leaving.step('waiting');
    await s.leaving.step('waiting');
    /* Stopped once, and then the updater is asked for what it holds, once. */
    expect(s.state.halts).toBe(3);
    expect(s.asked()).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(s.controlDir, UPLOAD_FILE)).mode & 0o777).toBe(0o600);
  });

  it('gives the leader what the updater packed, and offers it again until the leader says it has it', async () => {
    const s = stand();
    await s.leaving.step('waiting');
    const first = s.asked();
    /* While the updater works, nothing more is asked and nothing is sent. */
    await s.leaving.step('waiting');
    expect([s.asked(), s.state.puts]).toEqual([first, []]);
    const id = s.updater();
    /* The leader is busy with another upload: offered again a minute later, the same file. */
    s.state.answer = 409;
    await s.leaving.step('waiting');
    await s.leaving.step('waiting');
    expect(s.state.puts).toEqual([{ id, bytes: `rows of ${id}`, length: `rows of ${id}`.length }]);
    s.later(UPLOAD_AGAIN_MS);
    s.state.answer = new Error('no leader of the company is in reach');
    await s.leaving.step('waiting');
    s.later(UPLOAD_AGAIN_MS);
    s.state.answer = 201;
    await s.leaving.step('waiting');
    expect(s.state.puts.map(put => put.id)).toEqual([id, id, id]);
    /* Taken: the file stays, and is offered again only much later, in case the leader could not load it. */
    s.later(UPLOAD_AGAIN_MS);
    await s.leaving.step('waiting');
    expect(s.state.puts).toHaveLength(3);
    expect(s.uploads()).toEqual([`${id}.done`, `${id}.tar.gz`]);
    s.later(RETRY_UPLOAD_MS);
    await s.leaving.step('waiting');
    expect(s.state.puts.map(put => put.id)).toEqual([id, id, id, id]);
    expect(s.asked()).toBeNull();
    /* The leader has it as a database: the packed file goes, and nothing is asked or sent any more. */
    await s.leaving.step('received');
    await s.leaving.step('received');
    expect([s.uploads(), s.asked(), s.state.puts.length, existsSync(join(s.controlDir, WIPE_FILE))]).toEqual([[], null, 4, false]);
    /* The leader lost that database before it read it: the machine is asked again, and makes a new upload. */
    await s.leaving.step('waiting');
    expect(s.asked()).not.toBe(id);
  });

  it('asks again for an upload the updater could not make', async () => {
    const s = stand();
    await s.leaving.step('waiting');
    const failed = s.updater(false);
    await s.leaving.step('waiting');
    expect([s.asked(), s.state.puts]).toEqual([null, []]);
    s.later(UPLOAD_AGAIN_MS);
    await s.leaving.step('waiting');
    expect(s.asked()).not.toBeNull();
    expect(s.asked()).not.toBe(failed);
    expect(s.uploads()).toEqual([]);
  });

  it('wipes only after the leader keeps what it held', async () => {
    const s = stand();
    for (const name of [COPY_STATE, 'frpc-peer.toml', 'frpc-visit.toml', 'machine.key']) writeFileSync(join(s.dir, name), 'x');
    await s.leaving.step('waiting');
    s.updater();
    await s.leaving.step('waiting');
    await s.leaving.step('received');
    expect(existsSync(join(s.controlDir, WIPE_FILE))).toBe(false);
    expect(readdirSync(s.dir).sort()).toEqual([COPY_STATE, 'frpc-peer.toml', 'frpc-visit.toml', 'machine.key'].sort());
    await s.leaving.step('wipe');
    const { id, server } = JSON.parse(readFileSync(join(s.controlDir, WIPE_FILE), 'utf8')) as { id: string; server?: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    /* It names the company's address, which a machine the company was installed on reaches as a worker afterwards. */
    expect(server).toBe('https://acme.hornhoof.test');
    expect(statSync(join(s.controlDir, WIPE_FILE)).mode & 0o777).toBe(0o600);
    /* What the keeper's own folder held of the copy went first; the machine's own key stays. */
    expect(readdirSync(s.dir)).toEqual(['machine.key']);
    /* The updater keeps the request until every step is done, with the step it is at: it is never written over. */
    writeFileSync(join(s.controlDir, WIPE_FILE), JSON.stringify({ id, step: 'volume' }));
    await s.leaving.step('wipe');
    expect(JSON.parse(readFileSync(join(s.controlDir, WIPE_FILE), 'utf8'))).toEqual({ id, step: 'volume' });
    /* A company with no link names none. */
    const plain = stand();
    plain.state.server = null;
    await plain.leaving.step('wipe');
    expect(Object.keys(JSON.parse(readFileSync(join(plain.controlDir, WIPE_FILE), 'utf8')) as object)).toEqual(['id']);
    /* And once it is done, no second wipe is asked for while the leader has not heard of it yet. */
    rmSync(join(s.controlDir, WIPE_FILE));
    writeFileSync(join(s.controlDir, WIPED_FILE), JSON.stringify({ id, at: new Date().toISOString() }));
    await s.leaving.step('wipe');
    expect(existsSync(join(s.controlDir, WIPE_FILE))).toBe(false);
  });
});
