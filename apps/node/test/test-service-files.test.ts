import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyServiceTree, withServiceDirectory, writeServiceFile } from '../src/test-service-files.js';

const race = vi.hoisted(() => ({ afterOpen: undefined as (() => void) | undefined, afterCopy: undefined as (() => void) | undefined,
  afterStage: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    mkdtempSync: new Proxy(fs.mkdtempSync, { apply(target, receiver, args) {
      const path = Reflect.apply(target, receiver, args) as string;
      if (String(args[0]).includes('.service-copy-')) { const hook = race.afterStage; race.afterStage = undefined; hook?.(path); }
      return path;
    } }),
    openSync: new Proxy(fs.openSync, { apply(target, receiver, args) {
      const fd = Reflect.apply(target, receiver, args) as number;
      if (String(args[0]).endsWith('/config')) { const hook = race.afterOpen; race.afterOpen = undefined; hook?.(); }
      return fd;
    } }),
    cpSync: new Proxy(fs.cpSync, { apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      const hook = race.afterCopy; race.afterCopy = undefined; hook?.();
      return result;
    } }),
  };
});

let root: string;
const user = { uid: process.getuid!(), gid: process.getgid!() };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hh-service-files-')); });
afterEach(() => { vi.restoreAllMocks(); race.afterOpen = undefined; race.afterCopy = undefined; race.afterStage = undefined; rmSync(root, { recursive: true, force: true }); });

it('keeps an opened ancestor pinned when the job replaces its path with a link', () => {
  const directory = join(root, 'service'), moved = join(root, 'moved'), outside = join(root, 'outside');
  mkdirSync(directory); mkdirSync(outside);
  writeFileSync(join(outside, 'config'), 'untouched');
  withServiceDirectory(directory, false, pinned => {
    renameSync(directory, moved); symlinkSync(outside, directory);
    writeFileSync(join(pinned, 'config'), 'inside');
  });
  expect(readFileSync(join(outside, 'config'), 'utf8')).toBe('untouched');
  expect(readFileSync(join(moved, 'config'), 'utf8')).toBe('inside');
});

it('creates missing service directories without changing existing ancestors', () => {
  const nested = join(root, 'new', 'nested');
  withServiceDirectory(nested, true, pinned => writeFileSync(join(pinned, 'config'), 'inside'));
  expect(readFileSync(join(nested, 'config'), 'utf8')).toBe('inside');
  expect(statSync(nested).mode & 0o777).toBe(0o700);
});

it('recreates access rules when the job removed the previous file', () => {
  const file = join(root, 'config');
  writeServiceFile(file, 'access rules', user, true);
  expect(readFileSync(file, 'utf8')).toBe('access rules');
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('writes and changes ownership through the opened file after its name is replaced', () => {
  const file = join(root, 'config'), outside = join(root, 'outside');
  writeFileSync(outside, 'untouched', { mode: 0o640 });
  const before = statSync(outside);
  race.afterOpen = () => { rmSync(file); symlinkSync(outside, file); };
  writeServiceFile(file, 'private', user);
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  const after = statSync(outside);
  expect([after.uid, after.gid, after.mode, after.ino]).toEqual([before.uid, before.gid, before.mode, before.ino]);
});

it.each(['file', 'symlink', 'hardlink'])('never overwrites an existing password %s', kind => {
  const outside = join(root, 'outside'), file = join(root, 'config');
  writeFileSync(outside, 'untouched');
  if (kind === 'file') writeFileSync(file, 'existing');
  else if (kind === 'symlink') symlinkSync(outside, file);
  else linkSync(outside, file);
  expect(() => writeServiceFile(file, 'secret', user)).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  expect(readFileSync(file, 'utf8')).toBe(kind === 'file' ? 'existing' : 'untouched');
});

it('copies into a private tree and publishes through the pinned destination parent', () => {
  const source = join(root, 'source'), parent = join(root, 'attempt'), moved = join(root, 'moved'), outside = join(root, 'outside');
  mkdirSync(source); mkdirSync(parent); mkdirSync(outside);
  writeFileSync(join(source, 'config'), 'prepared');
  race.afterCopy = () => { renameSync(parent, moved); symlinkSync(outside, parent); };
  copyServiceTree(source, join(parent, 'pg'), user);
  expect(readdirSync(outside)).toEqual([]);
  expect(readFileSync(join(moved, 'pg', 'config'), 'utf8')).toBe('prepared');
  expect(statSync(join(moved, 'pg', 'config')).uid).toBe(user.uid);
  expect(readdirSync(moved)).toEqual(['pg']);
});

it('rejects linked copied state before handing any file to the job', () => {
  const source = join(root, 'source'), outside = join(root, 'outside'), destination = join(root, 'pg');
  mkdirSync(source); writeFileSync(outside, 'untouched'); symlinkSync(outside, join(source, 'config'));
  expect(() => copyServiceTree(source, destination, user)).toThrow();
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  expect(readdirSync(root).sort()).toEqual(['outside', 'source']);
});

it('does not follow a link already occupying the copy destination', () => {
  const source = join(root, 'source'), outside = join(root, 'outside'), destination = join(root, 'pg');
  mkdirSync(source); mkdirSync(outside);
  writeFileSync(join(source, 'config'), 'prepared'); writeFileSync(join(outside, 'config'), 'untouched');
  symlinkSync(outside, destination);
  expect(() => copyServiceTree(source, destination, user)).toThrow();
  expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, 'config'), 'utf8')).toBe('untouched');
});

it.each(['owner', 'mode'])('rejects a copy staging directory with an unsafe %s', kind => {
  const source = join(root, 'source'), destination = join(root, 'pg');
  mkdirSync(source); writeFileSync(join(source, 'config'), 'prepared');
  if (kind === 'owner') vi.spyOn(process, 'geteuid').mockReturnValue(user.uid + 1);
  else race.afterStage = path => chmodSync(path, 0o755);
  expect(() => copyServiceTree(source, destination, user)).toThrow(/private/);
  expect(readdirSync(root)).toEqual(['source']);
});

it('rejects a hardlink inserted before the ownership handoff', () => {
  const source = join(root, 'source'), outside = join(root, 'outside'), destination = join(root, 'pg');
  mkdirSync(source); writeFileSync(join(source, 'config'), 'prepared'); writeFileSync(outside, 'untouched');
  race.afterCopy = () => {
    const stage = readdirSync(root).find(name => name.startsWith('.service-copy-'))!;
    const file = join(root, stage, 'payload', 'config'); rmSync(file); linkSync(outside, file);
  };
  expect(() => copyServiceTree(source, destination, user)).toThrow(/links/);
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  expect(readdirSync(root).sort()).toEqual(['outside', 'source']);
});
