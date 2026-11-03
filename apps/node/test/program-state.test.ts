import { readFileSync } from 'node:fs';
import { PROGRAM_SCREEN_MAX, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { BUSY, lastScreen, programState, ProgramWatch, REPORT_MS } from '../src/terminal/program-state.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const RULE = '─'.repeat(50);
const bash = { name: 'Bash', at: 1000 };

/* What each program shows at work and at its empty prompt, as the fakes show it after the programs. */
const SCREENS = {
  claude: { working: `❯ Fix the build\n✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)\n${RULE}\n❯ \n${RULE}`, waiting: fixture('claude-idle-screen') },
  codex: { working: `› Fix the build\n• Working (12s • esc to interrupt)\n\n\x1b[0;1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m`, waiting: fixture('codex-busy-screen') },
  kimi: { working: fixture('kimi-empty-screen'), waiting: fixture('kimi-empty-screen') },
  antigravity: { working: `\x1b[1m›\x1b[22m Fix the build\nLooking at the build`, waiting: `\x1b[1m›\x1b[22m Fix the build\nThe build passes.\n\n\x1b[1m›\x1b[22m ` },
} as const;

describe('what a program does, as its node sees it', () => {
  it.each(Object.keys(SCREENS) as (keyof typeof SCREENS)[])('tells each state of %s from its screen and its log', kind => {
    const { working, waiting } = SCREENS[kind];
    /* Kimi Code's screen does not tell; its log says when its turn runs. */
    const logged = kind === 'kimi';
    expect(programState(kind, working, null, logged)).toBe('thinking');
    expect(programState(kind, waiting, null, false)).toBe('idle');
    expect(programState(kind, working, bash, logged)).toBe('tool');
    expect(programState(kind, working, { name: 'AskUserQuestion', at: 1000 }, logged)).toBe('asking');
    expect(programState(kind, null, bash, logged)).toBe('gone');
    /* A tool whose result never reached the log does not keep a program at its empty prompt at work. */
    expect(programState(kind, waiting, bash, false)).toBe('idle');
  });

  it('shows Claude Code and Codex at work by the way to stop them, Kimi Code by its log and Antigravity by its prompt that is not there', () => {
    expect(BUSY.claude(SCREENS.claude.working, false)).toBe(true);
    expect(BUSY.codex(SCREENS.codex.working, false)).toBe(true);
    expect(BUSY.kimi(SCREENS.kimi.working, true)).toBe(true);
    expect(BUSY.antigravity(SCREENS.antigravity.working, false)).toBe(true);
    /* Only Kimi Code's screen does not tell, so only its log counts. */
    for (const kind of ['claude', 'codex', 'kimi', 'antigravity'] as const) expect(BUSY[kind](SCREENS[kind].waiting, kind !== 'kimi')).toBe(false);
  });

  it('keeps a prompt with words typed in it from counting as waiting for what to type', () => {
    expect(programState('claude', `${RULE}\n❯ half a line\n${RULE}`, null, false)).toBe('thinking');
  });
});

describe("the node's word on what a turn's program does", () => {
  const watched = (jobId: string | null = 'job-1') => {
    const sent: NodeMessage[] = [];
    return { sent, watch: new ProgramWatch(jobId, 'claude', m => sent.push(m)) };
  };
  const { working, waiting } = SCREENS.claude;

  it('goes out once for each change of state or tool, with since when and when the screen last changed', () => {
    const { sent, watch } = watched();
    expect(watch.look(1000, working, null, false)).toBe('thinking');
    watch.look(2000, `${working}.`, null, false);
    watch.look(3000, `${working}.`, bash, false);
    watch.look(4000, `${working}.`, { name: 'Read', at: 3500 }, false);
    watch.look(5000, waiting, null, false);
    expect(sent).toEqual([
      { type: 'job.program', jobId: 'job-1', state: 'thinking', since: 1000, screenAt: 1000 },
      { type: 'job.program', jobId: 'job-1', state: 'tool', since: 1000, tool: 'Bash', screenAt: 2000 },
      { type: 'job.program', jobId: 'job-1', state: 'tool', since: 3500, tool: 'Read', screenAt: 2000 },
      { type: 'job.program', jobId: 'job-1', state: 'idle', since: 5000, screenAt: 5000 },
    ]);
  });

  it('goes out again once a minute while nothing changes, no more often, and tells how long the program waits', () => {
    const { sent, watch } = watched();
    watch.look(0, waiting, null, false);
    for (let at = 5000; at < 3 * REPORT_MS; at += 5000) watch.look(at, waiting, null, false);
    expect(sent.map(m => (m as { screenAt: number }).screenAt)).toEqual([0, 0, 0]);
    expect(sent).toHaveLength(3);
    expect(watch.idleFor(3 * REPORT_MS - 5000)).toBe(3 * REPORT_MS - 5000);
    /* The host looks again as the next word is due. */
    expect([watch.due(3 * REPORT_MS - 1), watch.due(3 * REPORT_MS)]).toEqual([false, true]);
  });

  it('keeps a program that thinks long, its screen moving and its log quiet, thinking', () => {
    const { sent, watch } = watched();
    for (let at = 0; at <= 5 * REPORT_MS; at += 5000) watch.look(at, `${working} ${at}`, null, false);
    expect(new Set(sent.map(m => (m as { state: string }).state))).toEqual(new Set(['thinking']));
    expect(watch.idleFor(5 * REPORT_MS)).toBe(0);
  });

  it('tells a program gone with how it ended and its last screen', () => {
    const { sent, watch } = watched();
    watch.look(1000, working, bash, false);
    watch.gone(2000, { code: 3, signal: null }, 'fake claude\nError: out of memory\n\n\n');
    watch.gone(2500, null, '');
    expect(sent.slice(1)).toEqual([
      { type: 'job.program', jobId: 'job-1', state: 'gone', since: 2000, screenAt: 2000, exitCode: 3, signal: null, screen: 'fake claude\nError: out of memory' },
      /* A session gone whole tells neither how it ended. */
      { type: 'job.program', jobId: 'job-1', state: 'gone', since: 2000, screenAt: 2000, exitCode: null, signal: null, screen: '' },
    ]);
    expect(watch.idleFor(3000)).toBe(0);
  });

  it("keeps a gone program's last 40 lines, at most as much as Hornhoof takes", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(lastScreen(lines.join('\n'))).toBe(lines.slice(10).join('\n'));
    const long = lastScreen(`${'x'.repeat(3000)}\n${'y'.repeat(3000)}`);
    expect(long).toHaveLength(PROGRAM_SCREEN_MAX);
    expect(long.endsWith('y'.repeat(3000))).toBe(true);
    /* tmux leaves the rows of a dead pane blank above its word on how the program ended. */
    expect(lastScreen(`● Done.\n❯ ${'\n'.repeat(45)}Pane is dead (status 3)\n\n`)).toBe('● Done.\n❯ \n\nPane is dead (status 3)');
  });

  it('says nothing for a turn without a job, though it still sees the program wait', () => {
    const { sent, watch } = watched(null);
    /* Nothing is due before the first look. */
    expect(watch.due(0)).toBe(false);
    watch.look(0, waiting, null, false);
    expect(sent).toEqual([]);
    expect(watch.idleFor(1000)).toBe(1000);
  });
});
