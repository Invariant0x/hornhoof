import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envFile, Tmux } from '../src/terminal/tmux.js';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out');
};

describe.skipIf(!hasTmux)('tmux sessions for agents', () => {
  const socket = `hh-test-${process.pid}`;
  const tmux = new Tmux({ socket, env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), NODE_KEY: 'leak' } });
  afterEach(async () => tmux.stopAll());

  it('starts a program in its own session, pastes a prompt into it and reads its screen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    await tmux.launch('a-1', { cwd: dir, command: ['sh', '-c', 'printf "ready\\n"; read line; printf "got:%s\\n" "$line"; sleep 30'], cols: 80, rows: 24 });
    await until(async () => (await tmux.screen('a-1')).includes('ready'));
    await tmux.paste('a-1', 'hello there');
    await tmux.keys('a-1', 'Enter');
    await until(async () => (await tmux.screen('a-1')).includes('got:hello there'));
    expect(await tmux.alive('a-1')).toBe(true);
  });

  it("keeps the node's own key out of the session, and the screen after the program ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    await tmux.launch('a-2', { cwd: dir, command: ['sh', '-c', 'printf "key=%s done\\n" "${NODE_KEY:-none}"; sleep 0.3'], cols: 80, rows: 24 });
    await until(async () => (await tmux.screen('a-2')).includes('key=none done'));
    await until(async () => !(await tmux.alive('a-2')));
    expect(await tmux.screen('a-2')).toContain('key=none done');
    expect(await tmux.has('a-2')).toBe(true);
    expect(await tmux.has('a-3')).toBe(false);
  });

  it('starts the program again in the same session, with the env from a file it removes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    await tmux.launch('a-4', { cwd: dir, command: ['sh', '-c', 'echo first; sleep 30'], cols: 80, rows: 24 });
    await until(async () => (await tmux.screen('a-4')).includes('first'));
    const file = envFile(dir, { HH_SECRET_THING: "it's a 'quoted' value" });
    await tmux.launch('a-4', { cwd: dir, command: ['sh', '-c', 'echo "second $HH_SECRET_THING"; sleep 30'], cols: 80, rows: 24, envFile: file });
    await until(async () => (await tmux.screen('a-4')).includes("second it's a 'quoted' value"));
    expect(existsSync(file)).toBe(false);
  });
});

describe('env files for a program', () => {
  it('quote every value so the shell reads it back as it was, and only the owner reads the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-env-'));
    const file = envFile(dir, { A: "x'y", B: 'line $HOME `cmd`' });
    expect(readFileSync(file, 'utf8')).toBe("A='x'\\''y'\nB='line $HOME `cmd`'\n");
    const out = execFileSync('sh', ['-c', `set -a; . "${file}"; printf '%s|%s' "$A" "$B"`]).toString();
    expect(out).toBe("x'y|line $HOME `cmd`");
  });
});
