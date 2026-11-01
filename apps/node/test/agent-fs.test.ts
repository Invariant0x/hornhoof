import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('says why a write failed', async () => {
    fs = make();
    const file = join(mkdtempSync(join(tmpdir(), 'hh-afs-')), 'file');
    writeFileSync(file, 'x');
    await expect(fs.write(join(file, 'inside'), 'y')).rejects.toThrow(/ENOTDIR/);
    expect(existsSync(join(file, 'inside'))).toBe(false);
  });
});
