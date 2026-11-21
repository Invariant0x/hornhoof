import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordings } from '../src/disk/recordings.js';

const KIB = 1024;
const HOUR = 3600_000;
const NOW = Date.parse('2026-03-02T12:00:00Z');
const folders: string[] = [];
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const made = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  folders.push(dir);
  return dir;
};

const fill = (path: string, bytes: number, ageMs = 0) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const at = new Date(NOW - ageMs);
  utimesSync(path, at, at);
};

const SIDES = ['', '.ready', '.flush', '.position'];

/* A recording as the node's terminal writes it: its output and three small files beside it, in the folder of its socket. */
const recording = (folder: string, id: string, ageMs: number) => {
  const file = join(folder, `.hh-output-${id}.log`);
  for (const side of SIDES) fill(`${file}${side}`, side ? 0 : 256 * KIB, ageMs);
  return file;
};

/* The node's register names each recording of a session that is still there, in a file of its own. */
const register = (folder: string, session: string, file: string) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${session.repeat(64)}.json`), JSON.stringify({ name: `agent-${session}`, file }));
};

function node() {
  const dir = made('hh-disk-rec-');
  const folder = join(dir, '.hh-recordings', 'a'.repeat(64));
  fill(join(dir, 'work', 'agents', 'agent-a', 'shop', 'app.js'), 512 * KIB);
  return { dir, folder };
}

const cleaner = (dir: string) => recordings(dir, () => NOW);

describe("the recordings of a node's terminals, in its disk care", () => {
  it("count the node's folder of recordings and nothing of the agents' work", async () => {
    const { dir, folder } = node();
    register(folder, 'b', recording(folder, '0123456789abcdef', 0));
    const size = await cleaner(dir).size();
    expect(size).toBeGreaterThanOrEqual(256 * KIB);
    expect(size).toBeLessThan(512 * KIB);
  });

  it('remove what a stopped node left a day ago that no register names, and keep a quiet session, a new recording and other files', async () => {
    const { dir, folder } = node();
    const left = recording(folder, '1111111111111111', 25 * HOUR);
    fill(join(folder, '.hh-screen-2222222222222222'), 64 * KIB, 25 * HOUR);
    fill(join(folder, '.hh-env-7777777777777777'), 1 * KIB, 25 * HOUR);
    const quiet = recording(folder, '3333333333333333', 72 * HOUR);
    register(folder, 'c', quiet);
    const fresh = recording(folder, '4444444444444444', 1 * HOUR);
    fill(join(folder, 'notes.txt'), 4 * KIB, 72 * HOUR);

    const freed = await cleaner(dir).clean();

    expect(freed).toBeGreaterThanOrEqual((256 + 64) * KIB);
    for (const side of SIDES) expect(existsSync(`${left}${side}`)).toBe(false);
    expect(existsSync(join(folder, '.hh-screen-2222222222222222'))).toBe(false);
    expect(existsSync(join(folder, '.hh-env-7777777777777777'))).toBe(false);
    for (const side of SIDES) expect(existsSync(`${quiet}${side}`)).toBe(true);
    for (const side of SIDES) expect(existsSync(`${fresh}${side}`)).toBe(true);
    expect(existsSync(join(folder, 'notes.txt'))).toBe(true);
    expect(existsSync(join(folder, `${'c'.repeat(64)}.json`))).toBe(true);
  });

  it('keep every recording of a folder whose register it cannot read', async () => {
    const { dir, folder } = node();
    const left = recording(folder, '5555555555555555', 25 * HOUR);
    writeFileSync(join(folder, `${'d'.repeat(64)}.json`), '{"name":');
    expect(await cleaner(dir).clean()).toBe(0);
    expect(existsSync(left)).toBe(true);
  });

  it('never follow a link named as a recording', async () => {
    const { dir, folder } = node();
    const outside = join(made('hh-disk-outside-'), 'keep.log');
    fill(outside, 4 * KIB, 25 * HOUR);
    mkdirSync(folder, { recursive: true });
    symlinkSync(outside, join(folder, '.hh-screen-6666666666666666'));
    await cleaner(dir).clean();
    expect(existsSync(outside)).toBe(true);
  });

  it('find nothing to remove where the node never recorded', async () => {
    expect(await cleaner(node().dir).clean()).toBe(0);
  });
});
