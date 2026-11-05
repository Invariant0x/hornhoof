import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TERMINAL_REC = path.join(HERE, 'terminal.rec');

export type TerminalChunk = {
  atMs: number;
  data: string;
};

/* Parses terminal.rec where each non-empty line is "<ms since start> <base64 bytes>". */
export function readTerminalRec(filePath = DEFAULT_TERMINAL_REC): TerminalChunk[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: TerminalChunk[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) continue;
    const atMs = Number(trimmed.slice(0, space));
    const b64 = trimmed.slice(space + 1).trim();
    if (!Number.isFinite(atMs) || !b64) continue;
    out.push({ atMs, data: Buffer.from(b64, 'base64').toString('utf8') });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export type ReplayOptions = {
  filePath?: string;
  /* Optional gate: sends the initial prompt chunk right away and starts timed chunks once the gate resolves. */
  startAfter?: Promise<void>;
};

export type TerminalReplayController = {
  resetToPrompt: () => void;
};

/* Intercepts AgentTerminal's WebSocket and replays terminal.rec in real time. */
export async function routeTerminalReplay(page: Page, opts: ReplayOptions = {}): Promise<TerminalReplayController> {
  const chunks = readTerminalRec(opts.filePath ?? DEFAULT_TERMINAL_REC);
  let resetCurrent = () => {};
  await page.routeWebSocket('**/api/agents/*/terminal*', ws => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let closed = false;
    const send = (payload: unknown) => {
      if (!closed) ws.send(JSON.stringify(payload));
    };
    ws.onClose(() => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
    });
    ws.onMessage(() => {
      /* Resize and input frames from xterm need no server answer during replay. */
    });
    send({ type: 'ready', write: true });
    send({ type: 'program', running: true });
    const [first, ...rest] = chunks;
    resetCurrent = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      if (first) {
        send({ type: 'data', data: `\x1b[2J\x1b[H${first.data}` });
      }
    };
    if (opts.startAfter && first) {
      send({ type: 'data', data: first.data });
      void opts.startAfter.then(() => {
        if (closed) return;
        for (const chunk of rest) {
          timers.push(setTimeout(() => send({ type: 'data', data: chunk.data }), Math.max(0, chunk.atMs - first.atMs)));
        }
      });
      return;
    }
    for (const chunk of chunks) {
      timers.push(setTimeout(() => send({ type: 'data', data: chunk.data }), Math.max(0, chunk.atMs)));
    }
  });
  return {
    resetToPrompt: () => resetCurrent(),
  };
}
