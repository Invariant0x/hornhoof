import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import setupDatabase from './global-setup.js';
import { OWNER_FILE, removeTempFolder, removeTempFolders, tempFolder, tempFolderSync } from './temp-folder.js';

const here = dirname(fileURLToPath(import.meta.url));
let scratch: string, previous: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hh-temp-folder-test-'));
  previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
});
afterEach(() => {
  removeTempFolders();
  if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});

const startOf = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!;

describe('a folder a test helper keeps in the temporary folder', () => {
  it('is named from its prefix with six random letters, and names its owner, this process, for the machine to read', () => {
    const dir = tempFolderSync('hh-test-db-');
    expect(dirname(dir)).toBe(scratch);
    expect(dir.slice(scratch.length + 1)).toMatch(/^hh-test-db-[A-Za-z0-9]{6}$/);
    const owner = readFileSync(join(dir, OWNER_FILE), 'utf8').trim();
    expect(owner).toMatch(/^\d+( \d+)?$/);
    expect(owner.split(' ')[0]).toBe(String(process.pid));
    if (existsSync('/proc/self/stat')) expect(owner).toBe(`${process.pid} ${startOf(process.pid)}`);
  });

  it('is made the same way where the helper waits for it', async () => {
    const dir = await tempFolder('hh-installs-');
    expect(readFileSync(join(dir, OWNER_FILE), 'utf8')).toMatch(/^\d+/);
    writeFileSync(join(dir, 'file'), 'x');
    removeTempFolder(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('goes with what is in it, once, and a second call finds nothing to do', () => {
    const dir = tempFolderSync('hh-test-db-');
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    writeFileSync(join(dir, 'a/b/c'), 'x');
    removeTempFolder(dir);
    removeTempFolder(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('is removed with every other the process made and has not removed, as the process ends', () => {
    const one = tempFolderSync('hh-test-db-'), two = tempFolderSync('hh-installs-'), three = tempFolderSync('drz-');
    removeTempFolder(two);
    removeTempFolders();
    expect([one, two, three].map(dir => existsSync(dir))).toEqual([false, false, false]);
  });

  it.each([
    ['ends normally', 'process.exitCode = 0;'],
    ['exits with an error', 'process.exit(3);'],
    ['throws', 'throw new Error("boom");'],
    ['rejects', 'await Promise.reject(new Error("boom"));'],
  ])('is removed when the process that made it %s', (_how, ending) => {
    const script = join(scratch, 'child.mts');
    writeFileSync(script, `import { tempFolderSync } from ${JSON.stringify(join(here, 'temp-folder.ts'))};\nconst dir = tempFolderSync('hh-test-db-');\nconsole.log(dir);\n${ending}\n`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, TMPDIR: scratch }, encoding: 'utf8', cwd: join(here, '..') });
    const dir = child.stdout.trim().split('\n')[0]!;
    expect(dir).toMatch(/hh-test-db-/);
    expect(existsSync(dir)).toBe(false);
  });

  it.runIf(existsSync('/proc/self/stat'))('is left behind when the process is killed outright, with an owner that no longer lives, which is what lets the machine tell it from a live run', async () => {
    const script = join(scratch, 'child.mts');
    writeFileSync(script, `import { tempFolderSync } from ${JSON.stringify(join(here, 'temp-folder.ts'))};\nconsole.log(tempFolderSync('hh-test-db-'));\nsetInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, TMPDIR: scratch }, cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
    const dir = await new Promise<string>(resolve => child.stdout.once('data', chunk => resolve(String(chunk).trim())));
    const [pid, start] = readFileSync(join(dir, OWNER_FILE), 'utf8').trim().split(' ');
    expect(Number(pid)).toBe(child.pid);
    expect(start).toBe(startOf(child.pid!));
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  });
});

describe('the database a run of the server tests makes once', () => {
  const fakeDump = async () => Buffer.from([1, 2, 3]);
  const provided = () => ({ provide: () => {} });

  it('names its owner in its folder and takes it away when the run ends', async () => {
    const teardown = await setupDatabase(provided(), { dump: fakeDump, metadata: () => '{}' });
    const [dir] = readdirSync(scratch);
    expect(dir).toMatch(/^hh-test-db-/);
    expect(existsSync(join(scratch, dir!, OWNER_FILE))).toBe(true);
    teardown();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('takes its folder away when what it provides fails after the folder was made', async () => {
    const failing = { provide: () => { throw new Error('provide failed'); } };
    await expect(setupDatabase(failing, { dump: fakeDump, metadata: () => '{}' })).rejects.toThrow('provide failed');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('takes its folder away when its dump fails', async () => {
    await expect(setupDatabase(provided(), { dump: async () => { throw new Error('dump failed'); } })).rejects.toThrow('dump failed');
    expect(readdirSync(scratch)).toEqual([]);
  });
});
