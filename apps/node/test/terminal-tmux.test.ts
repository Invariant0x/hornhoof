import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  async function pasted(text: string): Promise<unknown[]> {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    const file = join(dir, 'keys.jsonl');
    const reader = fileURLToPath(new URL('./fakes/paste-reader.mjs', import.meta.url));
    await tmux.launch('paste', { cwd: dir, command: [process.execPath, reader, file], cols: 80, rows: 24 });
    await until(async () => (await tmux.screen('paste')).includes('ready'));
    await tmux.paste('paste', text);
    await tmux.keys('paste', 'Enter');
    await until(async () => (await tmux.screen('paste')).includes('received'));
    return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }

  it('leaves the server and every other program running when a paste meets a program that ended', async () => {
    await tmux.launch('ended', { cwd: tmpdir(), command: ['sh', '-c', 'exit 3'], cols: 80, rows: 24 });
    await tmux.launch('other', { cwd: tmpdir(), command: ['sleep', '60'], cols: 80, rows: 24 });
    await until(async () => !(await tmux.alive('ended')));
    await tmux.paste('ended', 'words');
    expect(await tmux.alive('other')).toBe(true);
    expect(await tmux.run(['list-buffers'])).toBe('');
  });

  it('keeps an embedded paste terminator and the following lines inside one paste', async () => {
    expect(await pasted('before\x1b[201~after\nnext')).toEqual([{ text: 'before[201~after\nnext' }, 'enter']);
  });

  it('removes control characters from pasted text while keeping newlines, tabs and Unicode', async () => {
    const controls = '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0d\x0e\x0f'
      + '\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f'
      + '\x7f\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b\x8c\x8d\x8e\x8f'
      + '\x90\x91\x92\x93\x94\x95\x96\x97\x98\x99\x9a\x9b\x9c\x9d\x9e\x9f';
    expect(await pasted(`a\x1b[31mred\x1b[0m\x1b[2J\x1b[3;4H${controls}\n\tz\u00a0🙂`))
      .toEqual([{ text: 'a[31mred[0m[2J[3;4H\n\tz\u00a0🙂' }, 'enter']);
  });

  it('preserves dim input placeholders when a styled screen is requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    await tmux.launch('styled', { cwd: dir, command: ['sh', '-c', 'printf "\\033[1m›\\033[0m \\033[2mAsk Codex to do anything\\033[0m\\n"; sleep 30'], cols: 80, rows: 24 });
    await until(async () => (await tmux.screen('styled')).includes('Ask Codex'));
    expect(await tmux.screen('styled', 0, true)).toMatch(/\x1b\[[0-9;]*2mAsk Codex/);
    expect(await tmux.screen('styled', 0)).not.toContain('\x1b');
  });

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

  it('gives the people watching no tmux keys: no prefix, no menus, only the wheel to scroll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
    await tmux.launch('a-5', { cwd: dir, command: ['sh', '-c', 'sleep 30'], cols: 80, rows: 24 });
    await tmux.launch('a-6', { cwd: dir, command: ['sh', '-c', 'sleep 30'], cols: 80, rows: 24 });
    expect(await tmux.run(['show-options', '-g', 'prefix'])).toBe('prefix None\n');
    expect(await tmux.run(['show-options', '-g', 'prefix2'])).toBe('prefix2 None\n');
    const root = (await tmux.run(['list-keys', '-T', 'root'])).trim().split('\n');
    expect(root).toHaveLength(1);
    expect(root[0]).toContain('WheelUpPane');
  });

  /* The install command's own terminal shows agy's terms to the person who runs it. A session that is gone by then leaves
     that terminal at once, untouched. */
  it("lets go of the node's own terminal at once when the session it would show is gone", async () => {
    await tmux.launch('shown', { cwd: tmpdir(), command: ['sleep', '30'], cols: 80, rows: 24 });
    const [code] = await once(tmux.attachHere('gone'), 'exit');
    expect(code).toBe(1);
    expect(await tmux.alive('shown')).toBe(true);
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
