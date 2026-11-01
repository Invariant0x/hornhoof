import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentFs, ownFs, type AgentFs } from '../src/agent-fs.js';

const me = { uid: process.getuid!(), gid: process.getgid!() };

describe.each([
  ['in the node itself', () => ownFs],
  ["in a process of the agents' own user", () => agentFs(me)],
])('file work in agent folders %s', (_name, make) => {
  let fs: AgentFs;
  afterEach(() => fs.stop());

  it('makes folders, writes files only the agent reads and reads them back', async () => {
    fs = make();
    const dir = join(mkdtempSync(join(tmpdir(), 'hh-afs-')), 'work', 'agent-1');
    await fs.mkdir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    await fs.write(join(dir, 'AGENTS.md'), 'Be brief.\n');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('Be brief.\n');
    expect(statSync(join(dir, 'AGENTS.md')).mode & 0o777).toBe(0o600);
    await fs.write(join(dir, 'AGENTS.md'), 'Be kind.\n');
    expect(await fs.read(join(dir, 'AGENTS.md'))).toBe('Be kind.\n');
    expect(await fs.read(join(dir, 'missing.md'))).toBeNull();
  });

  it('replaces a link left in place of a file instead of writing through it', async () => {
    fs = make();
    const dir = mkdtempSync(join(tmpdir(), 'hh-afs-'));
    writeFileSync(join(dir, 'node.json'), 'key');
    symlinkSync(join(dir, 'node.json'), join(dir, 'AGENTS.md'));
    await fs.write(join(dir, 'AGENTS.md'), 'Be brief.\n');
    expect(readFileSync(join(dir, 'node.json'), 'utf8')).toBe('key');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('Be brief.\n');
  });

  it('removes a folder whole, and copies one with its files and their modes', async () => {
    fs = make();
    const root = mkdtempSync(join(tmpdir(), 'hh-afs-'));
    const from = join(root, 'image', 'tdd');
    mkdirSync(join(from, 'scripts'), { recursive: true });
    writeFileSync(join(from, 'SKILL.md'), 'Test first.\n');
    writeFileSync(join(from, 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const to = join(root, 'work', '.agents', 'skills', 'tdd');
    await fs.mkdir(join(root, 'work', '.agents', 'skills'));
    await fs.copy(from, to);
    expect(readFileSync(join(to, 'SKILL.md'), 'utf8')).toBe('Test first.\n');
    expect(statSync(join(to, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    await fs.remove(to);
    expect(existsSync(to)).toBe(false);
    await fs.remove(to);
  });

  it('removes a link left in place of a folder, not what it points at', async () => {
    fs = make();
    const root = mkdtempSync(join(tmpdir(), 'hh-afs-'));
    mkdirSync(join(root, 'node'));
    writeFileSync(join(root, 'node', 'node.json'), 'key');
    symlinkSync(join(root, 'node'), join(root, 'tdd'));
    await fs.remove(join(root, 'tdd'));
    expect(existsSync(join(root, 'tdd'))).toBe(false);
    expect(readFileSync(join(root, 'node', 'node.json'), 'utf8')).toBe('key');
  });

  it("says whether there is a file or a folder at a path, as the agents' user sees it", async () => {
    fs = make();
    const root = mkdtempSync(join(tmpdir(), 'hh-afs-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    writeFileSync(join(root, 'tree.git'), 'gitdir: x\n');
    symlinkSync(join(root, 'repo', '.git'), join(root, 'linked'));
    mkdirSync(join(root, 'locked'));
    chmodSync(join(root, 'locked'), 0o000);
    expect(await fs.kind(join(root, 'repo', '.git'))).toBe('dir');
    expect(await fs.kind(join(root, 'tree.git'))).toBe('file');
    expect(await fs.kind(join(root, 'linked'))).toBe('dir');
    expect(await fs.kind(join(root, 'missing'))).toBeNull();
    expect(await fs.kind(join(root, 'tree.git', 'inside'))).toBeNull();
    expect(await fs.kind(join(root, 'locked', '.git'))).toBeNull();
    chmodSync(join(root, 'locked'), 0o755);
  });

  it('says why a write failed', async () => {
    fs = make();
    const file = join(mkdtempSync(join(tmpdir(), 'hh-afs-')), 'file');
    writeFileSync(file, 'x');
    await expect(fs.write(join(file, 'inside'), 'y')).rejects.toThrow(/ENOTDIR/);
    expect(existsSync(join(file, 'inside'))).toBe(false);
  });
});
