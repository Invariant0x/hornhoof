import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type * as XTerm from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasTmux, host, job, sent, setUp, tmux } from './terminal-host-helpers.js';

/* A browser's terminal without its page: the real xterm, fed only what the node sent, and sized as the page sizes it. */
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof XTerm;
const SCREEN = fileURLToPath(new URL('./fakes/fake-screen-term.mjs', import.meta.url));
const QUIET_MS = 700;

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const withoutBlankEnd = (rows: string[]) => {
  const kept = rows.map(row => row.trimEnd());
  while (kept.length && !kept.at(-1)) kept.pop();
  return kept;
};

class ViewTerminal {
  private readonly term: XTerm.Terminal;
  private fed = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly id: string, cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  }

  open(key: string, write: boolean) {
    return host.open({ type: 'term.open', termId: this.id, agentKey: key, cols: this.term.cols, rows: this.term.rows, write });
  }

  /* The page's order: its terminal takes the size first, and only then the node hears. */
  async size(cols: number, rows: number) {
    await this.feed();
    this.term.resize(cols, rows);
    await host.resize({ type: 'term.resize', termId: this.id, cols, rows });
    await this.settled();
  }

  async settled() {
    let seen = -1;
    let since = Date.now();
    for (const end = Date.now() + 10_000; Date.now() < end; await wait(25)) {
      await this.feed();
      if (this.fed !== seen) {
        seen = this.fed;
        since = Date.now();
      } else if (Date.now() - since >= QUIET_MS) return;
    }
  }

  rows() {
    const buffer = this.term.buffer.normal;
    return withoutBlankEnd(Array.from({ length: buffer.length }, (_, at) => buffer.getLine(at)!.translateToString(true)));
  }

  private feed() {
    const frames = sent.filter(m => m.type === 'term.data' && m.termId === this.id) as { data: string }[];
    for (; this.fed < frames.length; this.fed++) {
      const data = String(frames[this.fed]!.data);
      this.writing = this.writing.then(() => new Promise<void>(done => this.term.write(data, done)));
    }
    return this.writing;
  }
}

/* What tmux holds of a pane: its history, then its screen, row by row. */
const inTmux = async (name: string) => withoutBlankEnd((await tmux.run(['capture-pane', '-p', '-J', '-S', '-', '-E', '-', '-t', name])).split('\n'));
const twice = (rows: string[]) => {
  const count = new Map<string, number>();
  for (const row of rows) if (row) count.set(row, (count.get(row) ?? 0) + 1);
  return [...count].filter(([row, times]) => times > 1 && /^(line|new)-/.test(row)).map(([row]) => row);
};

/* A person sees the same rows in the same order as tmux has them: not the same set, and not one row twice. */
const expectSameRows = async (view: ViewTerminal, name: string) => {
  expect.soft(twice(view.rows())).toEqual([]);
  expect(view.rows()).toEqual(await inTmux(name));
};

describe.skipIf(!hasTmux)('a view\'s terminal holds what tmux holds, each row once and in order', () => {
  beforeEach(() => setUp());
  afterEach(() => host.stop());

  const session = async (key: string) => {
    await host.run(job(key, 'hello', { jobId: `job-${key}` }));
    return host['agents'].get(key)!.name;
  };
  const start = async (name: string, kind: string, view: ViewTerminal) => {
    await tmux.run(['respawn-pane', '-k', '-t', name, process.execPath, SCREEN, kind]);
    await view.settled();
  };
  const newLines = async (name: string, count: number, ...views: ViewTerminal[]) => {
    await tmux.run(['send-keys', '-t', name, '-l', 'n'.repeat(count)]);
    for (const view of views) await view.settled();
  };
  const opened = async (key: string, id: string, cols: number, rows: number, write: boolean) => {
    const view = new ViewTerminal(id, cols, rows);
    await view.open(key, write);
    await view.settled();
    return view;
  };

  describe('at one height', () => {
    it.each([true, false])('a view opened before the program, write: %s', async write => {
      const key = `same-${write}`;
      const name = await session(key);
      const view = await opened(key, key, 80, 24, write);
      await start(name, 'normal', view);
      await newLines(name, 40, view);
      await expectSameRows(view, name);
    });

    it('a view opened after the program wrote', async () => {
      const name = await session('late');
      const own = await opened('late', 'late-own', 80, 24, true);
      await start(name, 'normal', own);
      await newLines(name, 40, own);
      const late = await opened('late', 'late-view', 80, 24, false);
      await expectSameRows(late, name);
    });

    it('a program that only redraws its screen', async () => {
      const name = await session('redraw');
      const view = await opened('redraw', 'redraw', 80, 24, true);
      await start(name, 'normal', view);
      await tmux.run(['send-keys', '-t', name, '-l', 'rrrr']);
      await view.settled();
      await expectSameRows(view, name);
    });

    it('a program on its alternate screen', async () => {
      const name = await session('alt');
      const view = await opened('alt', 'alt', 80, 24, true);
      await start(name, 'alternate', view);
      await newLines(name, 10, view);
      await expectSameRows(view, name);
    });

    it('a window that gets narrower and wider again', async () => {
      const name = await session('wide');
      const view = await opened('wide', 'wide', 80, 24, true);
      await start(name, 'normal', view);
      await view.size(60, 24);
      await view.size(80, 24);
      await expectSameRows(view, name);
    });
  });

  it('a window that only gets lower', async () => {
    const name = await session('lower');
    const view = await opened('lower', 'lower', 80, 24, true);
    await start(name, 'normal', view);
    await view.size(80, 16);
    await expectSameRows(view, name);
  });

  describe('when a window gets taller, and tmux takes rows back from its history', () => {
    it.each([true, false])('its own window, write: %s', async write => {
      const key = `taller-${write}`;
      const name = await session(key);
      const own = write ? null : await opened(key, `${key}-own`, 80, 16, true);
      const view = await opened(key, key, 80, 16, write);
      await start(name, 'normal', view);
      await own?.size(80, 24);
      await view.size(80, 24);
      await expectSameRows(view, name);
    });

    /* The sizes a person's page goes through: the panel, full screen, a smaller page, a window fitted to it. */
    it('the panel, then full screen, then the page of the measurement', async () => {
      const name = await session('page');
      const view = await opened('page', 'page', 155, 40, true);
      await start(name, 'normal', view);
      await view.size(200, 49);
      await view.size(121, 25);
      await view.size(80, 24);
      await expectSameRows(view, name);
    });

    it('and the lines that come after it', async () => {
      const name = await session('after');
      const view = await opened('after', 'after', 80, 16, true);
      await start(name, 'normal', view);
      await view.size(80, 24);
      await newLines(name, 40, view);
      await expectSameRows(view, name);
    });
  });

  describe('when a later window makes the session lower for a moment', () => {
    const later = async (key: string, kind: string, lowest: number) => {
      const name = await session(key);
      const own = await opened(key, `${key}-own`, 80, 24, true);
      await start(name, kind, own);
      await newLines(name, 40, own);
      const view = await opened(key, `${key}-later`, 155, 41, false);
      await view.size(200, 50);
      await view.size(80, lowest);
      await view.size(80, 23);
      await view.size(80, 24);
      await own.settled();
      return { name, own, view };
    };

    it('the later window', async () => {
      const { name, view } = await later('later', 'normal', 20);
      await expectSameRows(view, name);
    });

    it('the window that kept its height', async () => {
      const { name, own } = await later('kept', 'normal', 20);
      await expectSameRows(own, name);
    });

    it('a program on its alternate screen, which keeps no history in tmux', async () => {
      const { name, view } = await later('later-alt', 'alternate', 19);
      await expectSameRows(view, name);
    });

    it('a window opened after all that holds each row once', async () => {
      const { name, own } = await later('fresh', 'normal', 20);
      const fresh = await opened('fresh', 'fresh-view', 80, 24, false);
      await own.settled();
      await expectSameRows(fresh, name);
    });
  });

  it('a window taller than the session loses nothing when its cursor is on the last row', async () => {
    const name = await session('tall');
    const own = await opened('tall', 'tall-own', 80, 24, true);
    const view = await opened('tall', 'tall-view', 80, 24, false);
    await start(name, 'last-row', view);
    await view.size(80, 40);
    await newLines(name, 8, view, own);
    expect(view.rows()).toEqual(await inTmux(name));
  });
});
