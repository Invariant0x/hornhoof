import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Tmux } from '../../node/src/terminal/tmux';
import { parentOf } from '../../node/src/terminal/host';
import { sendTerminalOutput, ViewHistory } from '../../node/src/terminal/view-stream';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

async function clientTty(tmux: Tmux, child: ReturnType<Tmux['attach']>) {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    for (const client of await tmux.clients()) if ((await parentOf(client.pid)) === child.pid) return client.tty;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

async function streamView(tmux: Tmux, child: ReturnType<Tmux['attach']>, send: (data: string) => void) {
  const tty = await clientTty(tmux, child);
  const history = new ViewHistory(tmux, 'agent', text => sendTerminalOutput(send, text), async () => { if (tty) await tmux.repaint(tty); });
  await history.open();
  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    history.saw(text);
    sendTerminalOutput(send, text);
  });
  child.stderr.resume();
  return history;
}

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();

test.skip(!hasTmux, 'tmux is required');
test('history stays in place and grows while the program redraws', async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-live-scroll-'));
  const tmux = new Tmux({ socket: `hh-live-scroll-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  const children: ReturnType<Tmux['attach']>[] = [];
  const histories: ViewHistory[] = [];
  try {
    const program = `let i=0,ticking=false;process.stdout.write(Array.from({length:80},(_,i)=>\`LINE-\${i}\\r\\n\`).join('')+String.fromCharCode(27)+'[?1049h'+String.fromCharCode(27)+'[?1000h'+String.fromCharCode(27)+'[?1006hALT-START\\r\\n');process.stdin.on('data',()=>{if(!ticking){ticking=true;setInterval(()=>process.stdout.write(\`TICK-\${i++}\\r\\n\`),250)}});setInterval(()=>{},1000)`;
    await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program] });
    await expect.poll(async () => (await tmux.screen('agent')).includes('ALT-START')).toBe(true);
    const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: false };
    let streamed = '';
    await serveAgentWindow(page, live);
    await page.routeWebSocket('**/api/agents/b1/terminal*', async ws => {
      const child = tmux.attach('agent', 80, 24, false);
      children.push(child);
      let history: ViewHistory | null = null;
      ws.onClose(() => {
        history?.stop();
        child.kill();
      });
      ws.send(JSON.stringify({ type: 'ready', write: false }));
      ws.send(JSON.stringify({ type: 'program', running: true }));
      history = await streamView(tmux, child, data => {
        streamed += data;
        ws.send(JSON.stringify({ type: 'data', data }));
      });
      histories.push(history);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /Development/ }).click();
    await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
    const rows = page.locator('.xterm-rows');
    await expect.poll(() => streamed).toContain('ALT-START');
    await expect(rows).toContainText('ALT-START');
    const box = await rows.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -8000);
    await expect(rows).toContainText('LINE-0');
    await tmux.paste('agent', 't\n');
    await expect.poll(async () => (await tmux.screen('agent')).includes('TICK-3')).toBe(true);
    await expect(rows).toContainText('LINE-0');
    await page.screenshot({ path: info.outputPath('live-history.png') });
    await page.mouse.wheel(0, 8000);
    await expect(rows).toContainText(/TICK-\d+/);
    await page.mouse.wheel(0, -8000);
    await expect(rows).toContainText('LINE-0');
  } finally {
    for (const history of histories) history.stop();
    for (const child of children) child.kill();
    await tmux.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});


for (const write of [false, true]) {
  test(`early view keeps 200 old and 44 new lines through repaint, resize and reconnect, write=${write}`, async ({ page }, info) => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-live-scroll-'));
    const tmux = new Tmux({ socket: `hh-live-scroll-${process.pid}-${write}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const children: ReturnType<Tmux['attach']>[] = [];
    const histories: ViewHistory[] = [];
    const sockets: { close(options: { code: number; reason: string }): void }[] = [];
    try {
      const program = `let started=false;process.stdin.on('data',d=>{const s=String(d);if(s.includes('s')&&!started){started=true;process.stdout.write(Array.from({length:200},(_,i)=>\`LINE-\${i}\\r\\n\`).join(''));setInterval(()=>process.stdout.write(\`TICK-\${Date.now()}\\r\\n\`),250)}if(s.includes('m'))process.stdout.write(Array.from({length:44},(_,i)=>\`NEW-\${i}\\r\\n\`).join(''))});setInterval(()=>{},1000)`;
      await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program] });
      const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: write };
      await serveAgentWindow(page, live);
      const inputs: string[] = [];
      let historyFrames = 0;
      await page.routeWebSocket('**/api/agents/b1/terminal*', async ws => {
        sockets.push(ws);
        const at = sockets.length;
        historyFrames = 0;
        const child = tmux.attach('agent', 80, 24, write);
        children.push(child);
        let history: ViewHistory | null = null;
        ws.onClose(() => {
          history?.stop();
          child.kill();
        });
        ws.onMessage(message => {
          const frame = JSON.parse(String(message)) as { type: string; data?: string };
          if (frame.type === 'input') inputs.push(frame.data!);
        });
        ws.send(JSON.stringify({ type: 'ready', write }));
        ws.send(JSON.stringify({ type: 'program', running: true }));
        history = await streamView(tmux, child, data => {
          if (at === sockets.length && data.includes('\x1b[1;2r')) historyFrames++;
          ws.send(JSON.stringify({ type: 'data', data }));
        });
        histories.push(history);
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await page.getByRole('button', { name: /Development/ }).click();
      await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
      const rows = page.locator('.xterm-rows');
      await expect(rows).toBeVisible();
      await tmux.paste('agent', 's\n');
      await expect(rows).toContainText('LINE-199');
      await expect.poll(() => historyFrames).toBeGreaterThan(0);
      const box = await rows.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      const inputsBeforeWheel = inputs.length;
      await page.mouse.wheel(0, -12000);
      await expect(rows).toContainText('LINE-0');
      await expect.poll(async () => ((await tmux.screen('agent', 200)).match(/TICK-/g) ?? []).length).toBeGreaterThanOrEqual(6);
      await expect(rows).toContainText('LINE-0');
      await tmux.paste('agent', 'm\n');
      await expect.poll(async () => (await tmux.screen('agent')).includes('NEW-43')).toBe(true);
      await expect(rows).toContainText('LINE-0');
      expect(inputs).toHaveLength(inputsBeforeWheel);
      await page.screenshot({ path: info.outputPath('live-history.png') });
      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(rows).toContainText('LINE-0');
      histories.at(-1)!.stop();
      children.at(-1)!.kill();
      const beforeReconnect = sockets.length;
      sockets.at(-1)!.close({ code: 4410, reason: 'node_offline' });
      await expect.poll(() => sockets.length).toBeGreaterThan(beforeReconnect);
      await expect(rows).toContainText('NEW-43');
      const inputsBeforeReconnectWheel = inputs.length;
      await page.mouse.wheel(0, -12000);
      await expect(rows).toContainText('LINE-0');
      expect(inputs).toHaveLength(inputsBeforeReconnectWheel);
    } finally {
      for (const history of histories) history.stop();
      for (const child of children) child.kill();
      await tmux.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('3J preserves the reading place and the bottom on the real terminal', async ({ page }, info) => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-live-scroll-'));
  const tmux = new Tmux({ socket: `hh-live-scroll-${process.pid}-clear`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
  const children: ReturnType<Tmux['attach']>[] = [];
  const histories: ViewHistory[] = [];
  try {
    const program = `process.stdout.write(Array.from({length:1000},(_,i)=>\`LINE-\${i}\\r\\n\`).join(''));setInterval(()=>{},1000)`;
    await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program] });
    const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: false };
    await serveAgentWindow(page, live);
    let streamed = '';
    await page.routeWebSocket('**/api/agents/b1/terminal*', async ws => {
      const child = tmux.attach('agent', 80, 24, false);
      children.push(child);
      let history: ViewHistory | null = null;
      ws.onClose(() => {
        history?.stop();
        child.kill();
      });
      ws.send(JSON.stringify({ type: 'ready', write: false }));
      ws.send(JSON.stringify({ type: 'program', running: true }));
      history = await streamView(tmux, child, data => {
        streamed += data;
        ws.send(JSON.stringify({ type: 'data', data }));
      });
      histories.push(history);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: /Development/ }).click();
    await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
    const rows = page.locator('.xterm-rows');
    await expect(rows).toContainText('LINE-999');
    await page.locator('.xterm-viewport').evaluate((el, line) => { el.scrollTop = el.scrollHeight * line / 1000; }, 676);
    await expect(rows).toContainText('LINE-700');
    histories.at(-1)!.resized();
    await expect.poll(() => streamed).toContain('\x1b[3J');
    await expect(rows).toContainText('LINE-700');
    await page.screenshot({ path: info.outputPath('clear-history-reading.png') });
    const box = await rows.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 12000);
    await expect(rows).toContainText('LINE-999');
    histories.at(-1)!.resized();
    await expect(rows).toContainText('LINE-999');
  } finally {
    for (const history of histories) history.stop();
    for (const child of children) child.kill();
    await tmux.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
