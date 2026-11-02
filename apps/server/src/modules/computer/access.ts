import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Ctx } from '../../app.js';
import { builtinMachine } from '../nodes/nodes.js';
import type { UpdaterControl } from '../updates/control.js';

/* How long one click of the CEO keeps access to the computer open. */
export const ACCESS_MS = 24 * 60 * 60 * 1000;
/* A command runs this many seconds unless the orchestrator gives its own time, never longer than the most. */
export const RUN_DEFAULT_S = 300;
export const RUN_MAX_S = 1800;
/* How long one tool call waits for a command's answer: under the minute Codex gives a tool. */
export const WAIT_MS = 45_000;
/* Files of commands nobody came back for go after this long. */
const FORGOTTEN_MS = 2 * (RUN_MAX_S * 1000);
const POLL_MS = 250;

export type Asked = { reason: string; at: string };
export type ComputerView = { available: boolean; until: string | null; asked: Asked | null };
export type RunResult = { exit: number; output: string };
/* A command's answer, or that it still runs, or that the updater has no such command. */
export type Waited = RunResult | 'running' | 'gone';
/* What the control folder keeps: until when access is open, in seconds for the updater and as a date for people, and
   what the orchestrator asked it for. */
type Settings = { untilSec: number | null; until: string | null; asked: Asked | null };
const CLOSED: Settings = { untilSec: null, until: null, asked: null };

/* Access to the computer the server runs on, kept in the control folder the app shares with the updater. The updater
   runs the orchestrator's commands there while it is open, and checks that itself too. */
/* The hostname of the company's machine the server runs on, when that computer joined as a machine; the CEO sees it
   on the access card and in the log, so it is plain which machine the access is to. */
export async function serverMachine(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string): Promise<string | null> {
  return (await builtinMachine(ctx.db, ctx.config.hostId, companyId))?.hostname ?? null;
}

/* What a line in the log says of the machine, when it is known. */
export const onMachine = (machine: string | null): Record<string, string> => (machine ? { machine } : {});

export class ComputerAccess {
  readonly waitMs: number;

  constructor(
    private readonly dir: string,
    private readonly updater: UpdaterControl,
    opts: { waitMs?: number } = {},
  ) {
    this.waitMs = opts.waitMs ?? WAIT_MS;
  }

  private read(): Settings {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'computer.json'), 'utf8')) as Partial<Settings>;
      return {
        untilSec: typeof s.untilSec === 'number' ? s.untilSec : null,
        until: typeof s.until === 'string' ? s.until : null,
        asked: s.asked && typeof s.asked.reason === 'string' && typeof s.asked.at === 'string' ? s.asked : null,
      };
    } catch {
      return CLOSED;
    }
  }

  /* Written whole and then moved, so the updater never reads half of it. */
  private write(s: Settings): void {
    const file = join(this.dir, 'computer.json');
    writeFileSync(`${file}.new`, JSON.stringify(s));
    renameSync(`${file}.new`, file);
  }

  /* Only a server with its updater reaches its computer. */
  available(): boolean {
    return this.updater.present();
  }

  /* Until when access is open, or null when it is closed or its day is over. */
  openUntil(now = Date.now()): string | null {
    const s = this.read();
    return s.untilSec !== null && s.untilSec * 1000 > now ? s.until : null;
  }

  view(): ComputerView {
    return { available: this.available(), until: this.openUntil(), asked: this.read().asked };
  }

  ask(reason: string): void {
    this.write({ ...this.read(), asked: { reason, at: new Date().toISOString() } });
  }

  /* Opens access for a day from now and answers what the orchestrator had asked it for. */
  open(now = Date.now()): { until: string; asked: Asked | null } {
    const { asked } = this.read();
    const untilSec = Math.floor((now + ACCESS_MS) / 1000);
    const until = new Date(untilSec * 1000).toISOString();
    this.write({ untilSec, until, asked: null });
    return { until, asked };
  }

  close(): void {
    this.write({ ...this.read(), untilSec: null, until: null });
  }

  /* Takes the orchestrator's request away; false when there was none. */
  decline(): boolean {
    const s = this.read();
    if (!s.asked) return false;
    this.write({ ...s, asked: null });
    return true;
  }

  /* Hands a command to the updater; its id fetches the answer. */
  start(command: string, timeoutS: number): string {
    const dir = join(this.dir, 'computer');
    mkdirSync(dir, { recursive: true });
    this.forget(dir);
    const id = randomUUID();
    const file = join(dir, `${id}.json`);
    writeFileSync(`${file}.new`, JSON.stringify({ id, command, timeout: timeoutS }));
    renameSync(`${file}.new`, file);
    return id;
  }

  /* Waits a while for the command's answer. An answer is taken: both files go, so it comes once. */
  async wait(id: string, ms = this.waitMs): Promise<Waited> {
    const file = join(this.dir, 'computer', `${id}.json`);
    const out = join(this.dir, 'computer', `${id}.out.json`);
    const end = Date.now() + ms;
    for (;;) {
      const answer = existsSync(out) ? readAnswer(out) : null;
      if (answer) {
        rmSync(file, { force: true });
        rmSync(out, { force: true });
        return answer;
      }
      if (!existsSync(file)) return 'gone';
      if (Date.now() >= end) return 'running';
      await sleep(POLL_MS);
    }
  }

  /* Commands and answers nobody came back for. */
  private forget(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > FORGOTTEN_MS) rmSync(path, { force: true });
      } catch {
        /* Gone already. */
      }
    }
  }
}

function readAnswer(file: string): RunResult | null {
  try {
    const a = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunResult>;
    return { exit: typeof a.exit === 'number' ? a.exit : -1, output: typeof a.output === 'string' ? a.output : '' };
  } catch {
    return null;
  }
}
