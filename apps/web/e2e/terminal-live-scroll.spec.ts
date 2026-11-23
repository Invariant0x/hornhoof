import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { TERM_CHUNK } from '@hornhoof/protocol';
import { expect as baseExpect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import ts from 'typescript';
import type * as ViewStream from '../../node/src/terminal/view-stream';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';

/* The node's view history and the agent window over what a real tmux said, recorded once in fixtures. Time is the test's
   own on both sides: the node's clock moves only when the test lets it, and so does the page's. */

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW_STREAM = join(HERE, '../../node/src/terminal/view-stream.ts');
/* A state is waited for as long as the test may run, never against a clock of its own. */
const expect = baseExpect.configure({ timeout: 0 });
const START = Date.parse('2026-11-09T12:00:00Z');
/* Enough of the page's time for it to take in what came and draw a few frames. */
const FRAMES_MS = 100;
/* How long the window waits before it opens a view again, the first time (RETRY_MS in AgentTerminal.tsx). */
const RETRY_MS = 500;

type Pane = { history: string; saved: string; top: string; status: string };
type Moment = { input: string | null; stream: string[]; pane: Pane; repaint: string[]; attach: string[] };
type Recording = { program: string; moments: Moment[] };
const RECORDED = JSON.parse(readFileSync(join(HERE, 'fixtures/terminal-live-scroll.json'), 'utf8')) as Record<'alternate' | 'early' | 'clear', Recording>;

type Timer = { at: number; run: () => void };

/* The node's clock in this test. A timer runs only when the test lets time go on, and then each read it starts runs to its
   end before the next timer. */
class NodeClock {
  private readonly timers = new Map<number, Timer>();
  private now = 0;
  private last = 0;

  readonly setTimeout = (run: () => void, ms = 0): number => {
    this.timers.set(++this.last, { at: this.now + ms, run });
    return this.last;
  };

  readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  /* Time goes on until no timer is left. */
  async settle(): Promise<void> {
    for (let next = this.first(); next; next = this.first()) {
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].run();
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  private first(): [number, Timer] | undefined {
    return [...this.timers].reduce<[number, Timer] | undefined>((first, timer) => (first && first[1].at <= timer[1].at ? first : timer), undefined);
  }
}

/* view-stream.ts as it is, compiled here so that its only timer, ViewHistory's, runs on the test's clock. */
const VIEW_STREAM_JS = ts.transpileModule(readFileSync(VIEW_STREAM, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const IMPORTS: Record<string, unknown> = { 'node:crypto': { randomUUID }, '@hornhoof/protocol': { TERM_CHUNK } };

function imported(name: string): unknown {
  if (name in IMPORTS) return IMPORTS[name];
  throw new Error(`view-stream.ts imports ${name}, which this test does not give it`);
}

function viewStream(clock: NodeClock): typeof ViewStream {
  const module = { exports: {} as typeof ViewStream };
  const load = runInThisContext(`(function (exports, require, module, setTimeout, clearTimeout) {${VIEW_STREAM_JS}\n})`, { filename: VIEW_STREAM }) as (...args: unknown[]) => void;
  load(module.exports, imported, module, clock.setTimeout, clock.clearTimeout);
  return module.exports;
}

/* tmux runs a line of commands apart at each ';'. */
function commandsOf(args: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (arg === ';') commands.push([]);
    else commands.at(-1)!.push(arg);
  }
  return commands.filter(command => command.length);
}

const lastLines = (text: string, count: number) => text.split('\n').slice(0, -1).slice(-count).map(line => `${line}\n`).join('');

/* tmux as recorded: for each command ViewHistory runs, what tmux said of the pane at the moment the program is at. A range
   of the history is the end of the whole history it said. */
class RecordedTmux {
  constructor(public pane: Pane) {}

  async run(args: string[]): Promise<string> {
    return commandsOf(args).map(command => this.answer(command)).join('');
  }

  private answer([name, ...flags]: string[]): string {
    if (name === 'display-message') return flags.includes('-t') ? this.pane.status : `${flags.at(-1)}\n`;
    if (name !== 'capture-pane') throw new Error(`tmux was not recorded for ${name}`);
    if (flags.includes('-a')) return this.pane.saved;
    const start = Number(flags[flags.indexOf('-S') + 1]);
    return start === 0 ? this.pane.top : lastLines(this.pane.history, -start);
  }
}

/* A view the window opened. It is ready once it was given the history and the first screen. */
type View = { ws: WebSocketRoute; history: ViewStream.ViewHistory; frames: string[]; sent: number; ready: boolean };

/* The recorded program as the node shows it to each view: the history first, then each piece of the attach stream to the
   view and to its history, and what tmux's client draws when it is repainted after a history was given. */
class RecordedProgram {
  readonly clock = new NodeClock();
  readonly views: View[] = [];
  readonly inputs: string[] = [];
  readonly resizes: string[] = [];
  private readonly stream = viewStream(this.clock);
  private readonly tmux: RecordedTmux;
  private at = 0;

  constructor(private readonly recording: Recording, private readonly write: boolean) {
    this.tmux = new RecordedTmux(recording.moments[0]!.pane);
  }

  /* The window opens a view twice when it first shows, as React does in development, and keeps the last one. */
  get view(): View {
    return this.views.at(-1)!;
  }

  get streamed(): string {
    return this.views.flatMap(view => view.frames).join('');
  }

  private get moment(): Moment {
    return this.recording.moments[this.at]!;
  }

  async serve(page: Page): Promise<void> {
    await page.routeWebSocket('**/api/agents/b1/terminal*', ws => this.connect(ws));
  }

  /* The program takes the input it was recorded with and writes what it wrote then. */
  async play(input: string): Promise<void> {
    this.at++;
    expect(this.moment.input).toBe(input);
    this.tmux.pane = this.moment.pane;
    this.draw(this.view, this.moment.stream);
    await this.clock.settle();
  }

  private async connect(ws: WebSocketRoute): Promise<void> {
    const history = new this.stream.ViewHistory(this.tmux, 'agent', text => this.send(view, text), async () => this.draw(view, this.moment.repaint));
    const view: View = { ws, history, frames: [], sent: 0, ready: false };
    this.views.push(view);
    ws.onClose(() => history.stop());
    ws.onMessage(message => this.took(String(message)));
    this.frame(view, { type: 'ready', write: this.write });
    this.frame(view, { type: 'program', running: true });
    await history.open();
    this.draw(view, this.moment.attach);
    view.ready = true;
  }

  private draw(view: View, chunks: string[]): void {
    for (const chunk of chunks) {
      view.history.saw(chunk);
      this.send(view, chunk);
    }
  }

  private send(view: View, text: string): void {
    this.stream.sendTerminalOutput(data => {
      view.frames.push(data);
      this.frame(view, { type: 'data', data });
    }, text);
  }

  private frame(view: View, message: object): void {
    view.sent++;
    view.ws.send(JSON.stringify(message));
  }

  private took(message: string): void {
    const frame = JSON.parse(message) as { type: string; data?: string };
    if (frame.type === 'input') this.inputs.push(frame.data!);
    if (frame.type === 'resize') this.resizes.push(message);
  }
}

type Seen = { terminalSocket: WebSocket | null; terminalFrames: number };

/* The page counts the frames its newest terminal socket took in, each once the window handled it. A socket the window
   closed at once took none. */
async function countFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = window as unknown as Seen;
    const dispatch = EventTarget.prototype.dispatchEvent;
    seen.terminalSocket = null;
    seen.terminalFrames = 0;
    EventTarget.prototype.dispatchEvent = function (event) {
      const handled = dispatch.call(this, event);
      if (event.type !== 'message' || !(this instanceof WebSocket) || !this.url.includes('/terminal')) return handled;
      if (seen.terminalSocket !== this) Object.assign(seen, { terminalSocket: this, terminalFrames: 0 });
      seen.terminalFrames++;
      return handled;
    };
  });
}

type Window = { page: Page; program: RecordedProgram; rows: Locator; live: AgentFixture };

async function socketClosed(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Seen).terminalSocket?.readyState)).toBe(3);
}

/* The page took in every frame the node sent to the view it keeps, and its time went on for it to draw them. */
async function drawn({ page, program }: Window): Promise<void> {
  await expect.poll(async () => {
    const taken = await page.evaluate(() => (window as unknown as Seen).terminalFrames);
    return program.view?.ready && taken === program.view.sent;
  }).toBe(true);
  await page.clock.runFor(FRAMES_MS);
}

/* The view comes to show this, the page's time going on a few frames at a time until it does. */
async function comesTo({ page, rows }: Window, text: string | RegExp): Promise<void> {
  await expect.poll(async () => {
    await page.clock.runFor(FRAMES_MS);
    return rows.textContent();
  }).toMatch(text);
}

/* What the view shows once the page drew what came: the page's time stands still meanwhile, so it shows it now or never. */
async function showsNow({ rows }: Window, text: string): Promise<void> {
  expect(await rows.textContent()).toContain(text);
}

async function step(window: Window, input: string): Promise<void> {
  await window.program.play(input);
  await drawn(window);
}

async function wheel({ page, rows }: Window, deltaY: number): Promise<void> {
  const box = (await rows.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function openWindow(page: Page, recording: Recording, write: boolean): Promise<Window> {
  const program = new RecordedProgram(recording, write);
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, canType: write };
  await serveAgentWindow(page, live);
  await program.serve(page);
  await countFrames(page);
  await chooseTerminal(page);
  await page.clock.install({ time: START - 60_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  /* Wait for the map's initial load to finish before pausing the clock, or pauseAt(+60 s) trips useLoad's 30 s timeout. */
  const department = page.getByRole('button', { name: /^Development/ });
  await expect(department).toBeVisible();
  await page.clock.pauseAt(START);
  await department.click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const window = { page, program, rows: page.locator('.xterm-rows'), live };
  await drawn(window);
  await program.clock.settle();
  await drawn(window);
  return window;
}

test('history stays in place and grows while the program redraws, and survives reconnect', async ({ page }, info) => {
  const window = await openWindow(page, RECORDED.alternate, false);
  const { program } = window;
  expect(program.streamed).toContain('ALT-START');
  await showsNow(window, 'ALT-START');
  await wheel(window, -8000);
  await comesTo(window, 'LINE-0');
  for (let tick = 0; tick < 4; tick++) {
    await step(window, 't\n');
    await showsNow(window, 'LINE-0');
  }
  expect(program.streamed).toContain('TICK-3');
  await page.screenshot({ path: info.outputPath('live-history.png') });
  const views = program.views.length;
  program.view.history.stop();
  await program.view.ws.close({ code: 4410, reason: 'node_offline' });
  await socketClosed(page);
  await page.clock.runFor(FRAMES_MS);
  await expect(page.locator('.t-load')).toHaveCount(0);
  await showsNow(window, 'LINE-0');
  await page.clock.runFor(RETRY_MS);
  await expect.poll(() => program.views.length).toBe(views + 1);
  await drawn(window);
  await program.clock.settle();
  await drawn(window);
  await expect(page.locator('.t-load')).toHaveCount(0);
  await showsNow(window, 'LINE-0');
  await wheel(window, 8000);
  await comesTo(window, /TICK-\d+/);
  await wheel(window, -8000);
  await comesTo(window, 'LINE-0');
});

for (const write of [false, true]) {
  test(`early view keeps 200 old and 44 new lines through repaint, resize and reconnect, write=${write}`, async ({ page }, info) => {
    const window = await openWindow(page, RECORDED.early, write);
    const { program, rows, live } = window;
    await expect(rows).toBeVisible();
    await step(window, 's\n');
    await showsNow(window, 'LINE-199');
    expect(program.view.frames.filter(frame => frame.includes('\x1b[1;2r')).length).toBeGreaterThan(0);
    const inputsBeforeWheel = program.inputs.length;
    await wheel(window, -12000);
    await comesTo(window, 'LINE-0');
    for (let tick = 0; tick < 6; tick++) {
      await step(window, 't\n');
      await showsNow(window, 'LINE-0');
    }
    await step(window, 'm\n');
    expect(program.streamed).toContain('NEW-43');
    await showsNow(window, 'LINE-0');
    expect(program.inputs).toHaveLength(inputsBeforeWheel);
    await page.screenshot({ path: info.outputPath('live-history.png') });
    const resizes = program.resizes.length;
    /* At 1100 the window keeps the terminal's size; at 900 the terminal has fewer columns. */
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(() => program.resizes.length).toBeGreaterThan(resizes);
    await drawn(window);
    await showsNow(window, 'LINE-0');
    await page.screenshot({ path: info.outputPath(`reconnect-before-write-${write}.png`) });
    const views = program.views.length;
    live.awake = false;
    program.view.history.stop();
    await program.view.ws.close({ code: 4410, reason: 'node_offline' });
    await socketClosed(page);
    await page.clock.runFor(FRAMES_MS);
    await expect(page.locator('.t-load')).toHaveCount(0);
    await showsNow(window, 'LINE-0');
    await page.screenshot({ path: info.outputPath(`reconnect-during-write-${write}.png`) });
    await page.clock.runFor(RETRY_MS);
    await expect.poll(() => program.views.length).toBe(views + 1);
    live.awake = true;
    await drawn(window);
    await program.clock.settle();
    await drawn(window);
    await expect(page.locator('.t-load')).toHaveCount(0);
    await showsNow(window, 'LINE-0');
    await page.screenshot({ path: info.outputPath(`reconnect-after-write-${write}.png`) });
    const inputsBeforeReconnectWheel = program.inputs.length;
    await wheel(window, 12000);
    await comesTo(window, 'NEW-43');
    await wheel(window, -12000);
    await comesTo(window, 'LINE-0');
    expect(program.inputs).toHaveLength(inputsBeforeReconnectWheel);
  });
}

test('stays mounted and at the bottom across a transient terminal=false poll and reconnect without flicker', async ({ page }, info) => {
  const window = await openWindow(page, RECORDED.early, true);
  const { program, live } = window;
  await step(window, 's\n');
  for (let tick = 0; tick < 6; tick++) await step(window, 't\n');
  await step(window, 'm\n');
  await showsNow(window, 'NEW-43');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  const views = program.views.length;
  live.awake = false;
  program.view.history.stop();
  await program.view.ws.close({ code: 4410, reason: 'node_offline' });
  await socketClosed(page);
  /* A 15 s background poll reports terminal=false while the node is reconnecting: the terminal stays mounted without flicker. */
  await page.clock.runFor(15_000);
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.locator('.t-load')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Terminal' })).toHaveCount(0);
  await expect.poll(() => program.views.length).toBeGreaterThan(views);
  live.awake = true;
  await drawn(window);
  await program.clock.settle();
  await drawn(window);
  await expect(page.locator('.t-load')).toHaveCount(0);
  await showsNow(window, 'NEW-43');
  await page.screenshot({ path: info.outputPath('reconnect-bottom-after.png') });
});

test('3J preserves the reading place and the bottom on the real terminal', async ({ page }, info) => {
  const window = await openWindow(page, RECORDED.clear, false);
  const { program } = window;
  await showsNow(window, 'LINE-999');
  await page.locator('.xterm-viewport').evaluate((el, line) => { el.scrollTop = el.scrollHeight * line / 1000; }, 676);
  await comesTo(window, 'LINE-700');
  program.view.history.resized();
  await program.clock.settle();
  expect(program.streamed).toContain('\x1b[3J');
  await drawn(window);
  await showsNow(window, 'LINE-700');
  await page.screenshot({ path: info.outputPath('clear-history-reading.png') });
  await wheel(window, 12000);
  await comesTo(window, 'LINE-999');
  program.view.history.resized();
  await program.clock.settle();
  await drawn(window);
  await showsNow(window, 'LINE-999');
});
