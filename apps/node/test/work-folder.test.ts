import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { workFolderError } from '../src/work-folder.js';

/* What an agent does to its work folder at the moment the node opens the check file there: just before, and just after. */
const race = vi.hoisted(() => ({ before: null as null | ((path: string) => void), after: null as null | ((path: string) => void) }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  const opening = ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    const check = basename(path).startsWith('.hh-write-check-');
    if (check) race.before?.(path);
    const fd = fs.openSync(...args);
    if (check) race.after?.(path);
    return fd;
  }) as typeof fs.openSync;
  return { ...fs, openSync: opening };
});

afterEach(() => {
  race.before = null;
  race.after = null;
});

/* A node's folder with the agents' work folder in it, and a folder outside it holding a file of the node's own. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'hh-work-folder-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'node');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const nodeFile = join(outside, 'node.json');
  writeFileSync(nodeFile, 'secret');
  return { dir, work: join(dir, 'work'), outside, nodeFile };
}

describe('workFolderError', () => {
  it('writes, flushes and removes its check file, and makes the work folder when there is none', async () => {
    const { dir, work } = machine();
    expect(await workFolderError(dir)).toBeNull();
    expect(readdirSync(work)).toEqual([]);
  });

  it('never follows a link an agent left at the check name of the node process to a file outside', async () => {
    const { dir, work, nodeFile } = machine();
    mkdirSync(work, { recursive: true });
    symlinkSync(nodeFile, join(work, `.hh-write-check-${process.pid}`));
    expect(await workFolderError(dir)).toBeNull();
    expect(readFileSync(nodeFile, 'utf8')).toBe('secret');
  });

  it('refuses a link put at the check name between choosing it and opening it, and writes nothing where it leads', async () => {
    const { dir, nodeFile } = machine();
    race.before = path => symlinkSync(nodeFile, path);
    expect(await workFolderError(dir)).toMatch(/EEXIST/);
    expect(readFileSync(nodeFile, 'utf8')).toBe('secret');
  });

  it('refuses a hard link put at the check name, which no link check sees, and writes nothing into the file it shares', async () => {
    const { dir, nodeFile } = machine();
    race.before = path => linkSync(nodeFile, path);
    expect(await workFolderError(dir)).toMatch(/EEXIST/);
    expect(readFileSync(nodeFile, 'utf8')).toBe('secret');
  });

  it('refuses a work folder that is a link and writes nothing in the folder it leads to', async () => {
    const { dir, work, outside, nodeFile } = machine();
    mkdirSync(dir);
    symlinkSync(outside, work);
    const theirs = join(outside, `.hh-write-check-${process.pid}`);
    writeFileSync(theirs, 'theirs');
    expect(await workFolderError(dir)).toBe(`${work} is a link, not a folder, so the node writes nothing through it.`);
    expect(readdirSync(outside).sort()).toEqual([basename(theirs), 'node.json']);
    expect(readFileSync(theirs, 'utf8')).toBe('theirs');
    expect(readFileSync(nodeFile, 'utf8')).toBe('secret');
  });

  /* Only Linux shows a folder the process holds open as a path, and only there does a node run as root over its agents. */
  it.skipIf(!existsSync('/proc/self/fd'))('writes in the folder it opened when the work folder is swapped for a link before the file opens', async () => {
    const { dir, work, outside } = machine();
    mkdirSync(work, { recursive: true });
    const moved = join(dir, 'work-before');
    race.before = () => {
      renameSync(work, moved);
      symlinkSync(outside, work);
    };
    let seen: { outside: string[]; moved: string[] } | null = null;
    race.after = path => (seen = { outside: readdirSync(outside), moved: readdirSync(moved).map(name => (name === basename(path) ? 'check' : name)) });
    expect(await workFolderError(dir)).toBeNull();
    expect(seen).toEqual({ outside: ['node.json'], moved: ['check'] });
    expect(readdirSync(outside)).toEqual(['node.json']);
    expect(readdirSync(moved)).toEqual([]);
  });
});
