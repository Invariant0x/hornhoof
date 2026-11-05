import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Tmux } from '../../node/src/terminal/tmux';
import { readViewHistory } from '../../node/src/terminal/view-stream';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();

test.skip(!hasTmux, 'tmux is required');
test('history stays in place and grows while the program redraws', async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-live-scroll-'));
  const tmux = new Tmux({ socket: `hh-live-scroll-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  try {
    const program = `let i=0;process.stdout.write(Array.from({length:80},(_,i)=>\`LINE-\${i}\\r\\n\`).join('')+String.fromCharCode(27)+'[?1049h'+String.fromCharCode(27)+'[?1000h'+String.fromCharCode(27)+'[?1006hALT-START\\r\\n');setInterval(()=>process.stdout.write(\`TICK-\${i++}\\r\\n\`),250)`;
    await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program] });
    await expect.poll(async () => (await tmux.screen('agent')).includes('ALT-START')).toBe(true);
    const child = tmux.attach('agent', 80, 24, false);
    const initial = await readViewHistory(tmux, 'agent');
    const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: false };
    await serveAgentWindow(page, live);
    await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
      ws.send(JSON.stringify({ type: 'ready', write: false }));
      ws.send(JSON.stringify({ type: 'program', running: true }));
      ws.send(JSON.stringify({ type: 'data', data: initial }));
      child.stdout.on('data', chunk => ws.send(JSON.stringify({ type: 'data', data: chunk.toString() })));
      child.stderr.resume();
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /Development/ }).click();
    await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
    const rows = page.locator('.xterm-rows');
    await expect(rows).toContainText('ALT-START');
    const box = await rows.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -8000);
    await expect(rows).toContainText('LINE-0');
    await expect.poll(async () => (await tmux.screen('agent')).includes('TICK-3')).toBe(true);
    await expect(rows).toContainText('LINE-0');
    await page.screenshot({ path: info.outputPath('live-history.png') });
    await page.mouse.wheel(0, 8000);
    await expect(rows).toContainText(/TICK-\d+/);
    await page.mouse.wheel(0, -8000);
    await expect(rows).toContainText('LINE-0');
    child.kill();
  } finally {
    await tmux.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
