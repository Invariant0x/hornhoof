import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Tmux } from '../src/terminal/tmux.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* A real tmux server of the test's own: a program that sleeps leaves its pane, and what it printed, to the next one. */
const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

function server() {
  const home = mkdtempSync(join(tmpdir(), 'hh-tmux-sleep-'));
  const tmux = new Tmux({ socket: `hh-sleep-${process.pid}-${stops.length}`, env: { PATH: process.env.PATH, HOME: home }, recordingsDir: join(home, 'recordings') });
  stops.push(async () => { await tmux.stopAll(); rmSync(home, { recursive: true, force: true }); });
  return tmux;
}

const program = (words: string) => ['sh', '-c', `for i in $(seq 1 80); do echo "${words} $i"; done; exec sleep 600`];

it.runIf(hasTmux)('ends a program that sleeps and keeps its pane with what it printed, for the next one to start in', async () => {
  const tmux = server();
  await tmux.launch('a-sleeper', { cwd: '/', command: program('first run'), cols: 80, rows: 10 });
  await eventually(async () => (await tmux.screen('a-sleeper', 200)).includes('first run 80'));
  expect(await tmux.livePrograms()).toEqual(['sleeper']);

  await tmux.stop('a-sleeper');
  expect(await tmux.alive('a-sleeper')).toBe(false);
  expect(await tmux.has('a-sleeper')).toBe(true);
  expect(await tmux.livePrograms()).toEqual([]);
  expect(await tmux.screen('a-sleeper', 0)).toContain('first run 80');
  expect(await tmux.screen('a-sleeper', 200)).toContain('first run 1\n');

  await tmux.launch('a-sleeper', { cwd: '/', command: program('second run'), cols: 80, rows: 10 });
  await eventually(async () => (await tmux.screen('a-sleeper', 200)).includes('second run 80'));
  expect(await tmux.alive('a-sleeper')).toBe(true);
  const history = await tmux.screen('a-sleeper', 1000);
  expect(history.indexOf('first run 80')).toBeGreaterThan(-1);
  expect(history.indexOf('first run 80')).toBeLessThan(history.indexOf('second run 1\n'));
});

it.runIf(hasTmux)('does nothing to a session that is not there', async () => {
  const tmux = server();
  await tmux.stop('a-nobody');
  expect(await tmux.has('a-nobody')).toBe(false);
});
