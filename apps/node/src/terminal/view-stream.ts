import { randomUUID } from 'node:crypto';
import { TERM_CHUNK } from '@hornhoof/protocol';
import type { Tmux } from './tmux.js';

const VIEW_HISTORY_LINES = 5000;
const SYNC_MS = 300;
const TRIES = 3;
const PANE = '#{history_size} #{history_limit} #{pane_width} #{pane_height} #{alternate_on} #{cursor_y} #{cursor_x}';

type Pane = { size: number; limit: number; width: number; height: number; alternate: boolean; row: number; col: number };

const paneOf = (said = ''): Pane => {
  const [size = 0, limit = 0, width = 0, height = 0, alternate = 0, row = 0, col = 0] = said.trim().split(' ').map(Number);
  return { size, limit, width, height, alternate: alternate === 1, row, col };
};
const sameRows = (a: Pane, b: Pane) => a.size === b.size && a.width === b.width && a.alternate === b.alternate;

const linesOf = (text: string): string[] => (text ? text.replace(/\n$/, '').split('\n') : []);

/* What a program left on its normal screen, without the empty rows below it. Without another screen there is nothing. */
const savedRows = (text: string): string[] => {
  const rows = linesOf(text);
  while (rows.length && !rows.at(-1)!.replace(/\x1b\[[0-9;]*m/g, '').trim()) rows.pop();
  return rows;
};

/* A terminal keeps what scrolls off the top of its screen, also from a region of two rows, whatever its height. So the
   lines scroll off the first two rows, and the rest of the screen stays. A terminal's saved cursor counts from the start of
   its history, which just grew, so the cursor is told again. */
export function intoHistory(lines: string[], screen?: { rows: string; row: number; col: number }): string {
  if (!lines.length) return '';
  const going = lines.map(line => `${line}\x1b[0m\r\n`).join('');
  const rows = screen ? linesOf(screen.rows).map((row, at) => `\x1b[${at + 1};1H${row}\x1b[0m`).join('') : '';
  const cursor = screen ? `\x1b[${screen.row + 1};${screen.col + 1}H` : '';
  return `\x1b7\x1b[0m\x1b[1;2r\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[1;1H${going}\n\x1b[r${rows}\x1b8${cursor}`;
}

const OPEN_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*|[\]PX^_][^\x07\x1b]*\x1b?|[ -/]*)$/;

/* The end of a stream that a terminal sequence has not finished in: anything put after it would break the sequence. */
export const openSequence = (stream: string): string => OPEN_SEQUENCE.exec(stream)?.[0] ?? '';

/* How many rows a view's terminal needs of what a pane's history took in since it was last read, at one height. At its limit
   tmux drops a tenth of it at once. A history cleared took nothing in, and at a new width all its rows are other rows. */
export function rowsGone(was: Pick<Pane, 'size' | 'limit' | 'width'>, now: Pick<Pane, 'size' | 'limit' | 'width'>): number {
  if (now.width !== was.width) return 0;
  if (now.size >= was.size) return now.size - was.size;
  const dropped = Math.max(1, Math.floor(now.limit / 10));
  return Math.min(now.size, was.size) >= now.limit - dropped ? now.size + dropped - was.size : 0;
}

/* What keeps a view's terminal history whole. tmux's client draws a screen, and only what it has time for: most of a burst
   never reaches the terminal. So it draws the screen alone, and each line that leaves the pane's screen comes from the
   pane's history, once. Later output belongs to the attach stream, not to wheel traffic.
   Rows are counted in tmux's history, which only a read at one moment can tell apart: when it moved between the count and
   the read, the read is of other rows, and is done again. Under output that never pauses the history waits for a pause.
   A program on its alternate screen left a screen of lines that are in neither its history nor that screen. They go to the
   history at once, and are skipped when they get there.
   A change of height moves rows between history and screen, and not the same in tmux and in a terminal. A taller tmux always
   takes rows back from its history; a terminal does only with its cursor on its last row, and also when only its own window
   got taller. A lower terminal keeps what it loses, where a program on its alternate screen has no history in tmux. No sequence
   takes single rows back from a terminal's history, so all of it goes and comes again, once the height stops changing. */
export class ViewHistory {
  private pane = paneOf();
  private given: string[] = [];
  private sequence = '';
  private timer: NodeJS.Timeout | null = null;
  private again = false;
  private stopped = false;
  private stale = false;
  private reading = false;

  constructor(
    private readonly tmux: Pick<Tmux, 'run'>,
    private readonly name: string,
    private readonly give: (text: string) => void,
    private readonly repaint: () => Promise<void>,
  ) {}

  /* What the screen shows is for the client to draw when it attaches. With an empty history tmux answers a range above the
     screen with the screen's first row. */
  async open(): Promise<void> {
    const [history = '', saved = '', status] = await this.say(this.capture('-S', String(-VIEW_HISTORY_LINES), '-E', '-1'), this.capture('-a', '-q'));
    this.pane = paneOf(status);
    this.given = savedRows(saved);
    this.give(intoHistory([...(this.pane.size ? linesOf(history) : []), ...this.given]));
  }

  /* The attach stream said this: rows may have left the screen. */
  saw(text: string): void {
    this.sequence = openSequence(this.sequence + text);
    this.wake();
  }

  /* The view's own window changed height, which its terminal followed at once. */
  resized(): void {
    this.stale = true;
    if (this.timer && !this.reading) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.timer) {
      this.again = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.reading = true;
      void this.sync().finally(() => {
        this.reading = false;
        this.slept();
      });
    }, SYNC_MS);
  }

  private slept(): void {
    this.timer = null;
    if (!this.again) return;
    this.again = false;
    this.wake();
  }

  private async sync(): Promise<void> {
    for (let tries = TRIES; tries > 0 && !this.stopped; tries--) if (await this.caughtUp()) return;
    this.again = true;
  }

  private async caughtUp(): Promise<boolean> {
    if (this.sequence) return false;
    const [status] = await this.say();
    if (!status || this.stopped) return true;
    const now = paneOf(status);
    if (this.stale || now.height !== this.pane.height) return this.gaveAll(now);
    const rows = Math.min(rowsGone(this.pane, now), VIEW_HISTORY_LINES);
    const left = now.alternate && !this.pane.alternate;
    if (rows || left) return this.gave(now, rows, left);
    this.pane = now;
    return true;
  }

  private async gave(wanted: Pane, rows: number, left: boolean): Promise<boolean> {
    const said = await this.say(this.capture('-a', '-q'), this.capture('-S', '0', '-E', '1'), ...(rows ? [this.capture('-S', String(-rows), '-E', '-1')] : []));
    const now = paneOf(said.at(-1));
    if (this.stopped) return true;
    if (this.sequence || !sameRows(now, wanted)) return false;
    this.pane = now;
    const [saved = '', top = '', history = ''] = said.slice(0, -1);
    const lines = this.notGiven(linesOf(history));
    if (left) lines.push(...this.keep(savedRows(saved)));
    if (!lines.length) return true;
    this.give(intoHistory(lines, { rows: top, row: now.row, col: now.col }));
    await this.repaint();
    return true;
  }

  /* A height that comes during the read moved a terminal's rows again, so it counts for the next read. */
  private async gaveAll(wanted: Pane): Promise<boolean> {
    this.stale = false;
    const said = await this.say(this.capture('-S', String(-VIEW_HISTORY_LINES), '-E', '-1'), this.capture('-a', '-q'), this.capture('-S', '0', '-E', '1'));
    const now = paneOf(said.at(-1));
    if (this.stopped) return true;
    if (this.sequence || !sameRows(now, wanted) || now.height !== wanted.height) {
      this.stale = true;
      return false;
    }
    const [history = '', saved = '', top = ''] = said.slice(0, -1);
    this.pane = now;
    this.given = savedRows(saved);
    this.give(`\x1b[3J${intoHistory([...(now.size ? linesOf(history) : []), ...this.given], { rows: top, row: now.row, col: now.col })}`);
    await this.repaint();
    return true;
  }

  private keep(saved: string[]): string[] {
    const fresh = this.notGiven(saved);
    this.given = saved;
    return fresh;
  }

  /* A program can clear what it left before it reaches the history. Then its lines are other lines, and all of them count. */
  private notGiven(lines: string[]): string[] {
    let at = 0;
    while (at < lines.length && lines[at] === this.given[at]) at++;
    this.given = at < lines.length ? [] : this.given.slice(at);
    return lines.slice(at);
  }

  private capture(...more: string[]): string[] {
    return ['capture-pane', '-p', '-e', '-J', ...more, '-t', this.name];
  }

  /* What tmux says for these commands at one moment, each apart, and last how the pane stands. Nothing, if it says nothing. */
  private async say(...captures: string[][]): Promise<string[]> {
    const mark = `hh-${randomUUID()}`;
    const said = await this.tmux.run([
      ...captures.flatMap(capture => [...capture, ';', 'display-message', '-p', mark, ';']),
      'display-message', '-p', '-t', this.name, PANE,
    ]).catch(() => '');
    return said.split(`${mark}\n`);
  }
}

/* Forward a view's output at once, in the same pieces the transport already accepts. */
export function sendTerminalOutput(send: (data: string) => void, text: string): void {
  for (let offset = 0; offset < text.length; offset += 2 * TERM_CHUNK) send(text.slice(offset, offset + 2 * TERM_CHUNK));
}
