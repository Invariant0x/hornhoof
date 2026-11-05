import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Tmux } from '../src/terminal/tmux.js';
import { readViewHistory } from '../src/terminal/view-stream.js';

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();
const fixtures: { tmux: Tmux; dir: string; child: ReturnType<Tmux['attach']> | null }[] = [];

async function fixture(alternate: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-view-history-'));
  const tmux = new Tmux({ socket: `hh-view-history-${process.pid}-${fixtures.length}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  const value = { tmux, dir, child: null as ReturnType<Tmux['attach']> | null };
  fixtures.push(value);
  const lines = Array.from({ length: 80 }, (_, i) => `LINE-${i}\\r\\n`).join('');
  const program = `process.stdout.write('${lines}' + '${alternate ? '\\x1b[?1049h' : ''}\\x1b[2mCURRENT\\x1b[0m\\r\\n');setTimeout(()=>process.stdout.write('LIVE-UPDATE\\r\\n'),200);setInterval(()=>{},1000)`;
  await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program] });
  await expect.poll(async () => (await tmux.screen('agent')).includes('CURRENT')).toBe(true);
  return value;
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    value.child?.kill();
    await value.tmux.stopAll();
    rmSync(value.dir, { recursive: true, force: true });
  }
});

describe.skipIf(!hasTmux)('initial terminal history', () => {
  for (const alternate of [false, true]) {
    it(`includes old styled lines and releases later output after history when alternate=${alternate}`, async () => {
      const { tmux, child: attached } = await fixture(alternate);
      void attached;
      const child = tmux.attach('agent', 80, 24, false);
      const value = fixtures.at(-1)!;
      value.child = child;
      const initial = await readViewHistory(tmux, 'agent');
      expect(initial).toContain('LINE-0');
      expect(initial).toContain('CURRENT');
      expect(initial).toMatch(/\x1b\[[0-9;]*2mCURRENT/);
      let streamed = initial;
      child.stdout.on('data', chunk => { streamed += chunk.toString(); });
      child.stderr.resume();
      await expect.poll(() => streamed.includes('LIVE-UPDATE')).toBe(true);
      expect(streamed.indexOf('LINE-0')).toBeLessThan(streamed.indexOf('LIVE-UPDATE'));
    });
  }
});
