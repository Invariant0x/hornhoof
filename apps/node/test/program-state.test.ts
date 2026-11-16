import { readFileSync } from 'node:fs';
import { PROGRAM_SCREEN_MAX, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { READY, idleScreen, lastScreen, programState, ProgramWatch, REPORT_MS } from '../src/terminal/program-state.js';
import { real } from './real-screens.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const agy = (name: string) => readFileSync(new URL(`./fixtures/agy-tui/screen-${name}`, import.meta.url), 'utf8');
const RULE = '─'.repeat(50);
const bash = { name: 'Bash', at: 1000 };

/* Empty prompt lines stay on screen while the programs work. */
const SCREENS = {
  claude: { working: `✻ Recombobulating… (4s · ↓ 691 tokens · thought for 1s)\n${RULE}\n❯ \n${RULE}`, waiting: fixture('claude-idle-screen') },
  codex: { working: fixture('codex-busy-screen'), waiting: fixture('codex-busy-screen') },
  kimi: { working: fixture('kimi-empty-screen'), waiting: fixture('kimi-empty-screen') },
  antigravity: { working: agy('busy.ansi'), waiting: agy('idle.ansi') },
} as const;
const KINDS = Object.keys(SCREENS) as (keyof typeof SCREENS)[];

describe('what a program reports about its work', () => {
  it.each(KINDS)('keeps %s thinking at an empty prompt while its turn runs', kind => {
    const { working } = SCREENS[kind];
    expect(working).not.toContain('esc to interrupt');
    expect(programState(working, null, true)).toBe('thinking');
  });

  it.each(KINDS)('keeps %s idle without a running turn, whatever its screen shows', kind => {
    const { working, waiting } = SCREENS[kind];
    for (const screen of [working, waiting, `${working}\nesc to interrupt`, `${waiting}half a line`]) {
      expect(programState(screen, null, false)).toBe('idle');
      expect(programState(screen, bash, false)).toBe('idle');
    }
  });

  it.each(KINDS.flatMap(kind => [
    { kind, name: 'Bash', state: 'tool' },
    { kind, name: 'AskUserQuestion', state: 'asking' },
  ] as const))('reports $state for $kind at an empty prompt', ({ kind, name, state }) => {
    expect(programState(SCREENS[kind].working, { name, at: 1000 }, true)).toBe(state);
  });

  it.each(KINDS)('reports %s gone when there is no program', () => {
    expect(programState(null, bash, true)).toBe('gone');
    expect(programState(null, null, false)).toBe('gone');
  });
});

describe('Antigravity readiness', () => {
  it.each([['idle.ansi', true], ['busy.ansi', false], ['queued.txt', false], ['interrupted.txt', true], ['trust.ansi', false]] as const)('reads %s', (name, ready) => {
    expect(READY.antigravity(agy(name))).toBe(ready);
  });

  it('requires the ready footer below the input rather than in its history', () => {
    expect(READY.antigravity(`? for shortcuts\n${agy('busy.ansi')}`)).toBe(false);
  });
});

describe("the node's word on what a turn's program does", () => {
  const watched = (jobId: string | null = 'job-1') => {
    const sent: NodeMessage[] = [];
    return { sent, watch: new ProgramWatch(jobId, m => sent.push(m)) };
  };
  const { working, waiting } = SCREENS.claude;

  it('goes out once for each change of state or tool, with since when and when the screen last changed', () => {
    const { sent, watch } = watched();
    expect(watch.look(1000, working, null, true)).toBe('thinking');
    watch.look(2000, `${working}.`, null, true);
    watch.look(3000, `${working}.`, bash, true);
    watch.look(4000, `${working}.`, { name: 'Read', at: 3500 }, true);
    watch.look(5000, waiting, null, false);
    expect(sent).toEqual([
      { type: 'job.program', jobId: 'job-1', state: 'thinking', since: 1000, screenAt: 1000 },
      { type: 'job.program', jobId: 'job-1', state: 'tool', since: 1000, tool: 'Bash', screenAt: 2000 },
      { type: 'job.program', jobId: 'job-1', state: 'tool', since: 3500, tool: 'Read', screenAt: 2000 },
      { type: 'job.program', jobId: 'job-1', state: 'idle', since: 5000, screenAt: 5000 },
    ]);
  });

  it('goes out again once a minute while nothing changes, no more often, and keeps the same state start', () => {
    const { sent, watch } = watched();
    watch.look(0, waiting, null, false);
    for (let at = 5000; at < 3 * REPORT_MS; at += 5000) watch.look(at, waiting, null, false);
    expect(sent.map(m => (m as { screenAt: number }).screenAt)).toEqual([0, 0, 0]);
    expect(sent).toHaveLength(3);
    expect(sent.every(m => m.type === 'job.program' && m.since === 0)).toBe(true);
    /* The host looks again as the next word is due. */
    expect([watch.due(3 * REPORT_MS - 1), watch.due(3 * REPORT_MS)]).toEqual([false, true]);
  });

  it('keeps a program that thinks long, its screen moving and its log quiet, thinking', () => {
    const { sent, watch } = watched();
    for (let at = 0; at <= 5 * REPORT_MS; at += 5000) watch.look(at, `${working} ${at}`, null, true);
    expect(new Set(sent.map(m => (m as { state: string }).state))).toEqual(new Set(['thinking']));
  });

  it('reports a pending script as a tool for twenty minutes at an empty prompt', () => {
    const { sent, watch } = watched();
    for (let at = 1000; at <= 20 * REPORT_MS + 1000; at += REPORT_MS) watch.look(at, working, bash, true);
    expect(sent).toHaveLength(21);
    expect(sent.every(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash' && m.since === 1000)).toBe(true);
  });

  it('tells a program gone with how it ended and its last screen', () => {
    const { sent, watch } = watched();
    watch.look(1000, working, bash, true);
    watch.gone(2000, { code: 3, signal: null }, 'fake claude\nError: out of memory\n\n\n');
    watch.gone(2500, null, '');
    expect(sent.slice(1)).toEqual([
      { type: 'job.program', jobId: 'job-1', state: 'gone', since: 2000, screenAt: 2000, exitCode: 3, signal: null, screen: 'fake claude\nError: out of memory' },
      /* A session gone whole tells neither how it ended. */
      { type: 'job.program', jobId: 'job-1', state: 'gone', since: 2000, screenAt: 2000, exitCode: null, signal: null, screen: '' },
    ]);
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
  });
});


describe('independent completion after a lost end', () => {
  it('recognizes the current completed response of recorded Codex', () => {
    expect(idleScreen('codex', real('codex-0.166.0-long-session'))).toBe(true);
  });

  it.each(['first', 'idle', 'busy', 'retrying', 'draft', 'empty-rows-draft', 'paragraphs-draft'])('keeps recorded Codex %s uncertain or working', name => {
    expect(idleScreen('codex', real(`codex-0.166.0-${name}`))).toBe(false);
  });

  it('does not reuse an older Codex completion before new work or a question', () => {
    const done = real('codex-0.166.0-long-session');
    expect(idleScreen('codex', done + real('codex-0.166.0-busy'))).toBe(false);
    expect(idleScreen('codex', done + real('codex-0.167.0-rate-limits-question'))).toBe(false);
    expect(idleScreen('codex', done.replaceAll('Worked for 6s', 'Still working for 6s'))).toBe(false);
  });

  it('recognizes the completed recorded Antigravity response at its idle footer', () => {
    expect(idleScreen('antigravity', agy('done.ansi'))).toBe(true);
  });

  it.each(['idle.ansi', 'busy.ansi', 'queued.txt', 'interrupted.txt', 'trust.ansi'])('keeps recorded Antigravity %s working or waiting for someone', name => {
    expect(idleScreen('antigravity', agy(name))).toBe(false);
  });

  it('rejects Antigravity drafts and an old idle footer before new work', () => {
    const done = agy('done.ansi');
    expect(idleScreen('antigravity', done.replace(/>\x1b\[39m\n/, '>draft\x1b[39m\n'))).toBe(false);
    expect(idleScreen('antigravity', done + agy('busy.ansi'))).toBe(false);
    expect(idleScreen('antigravity', done + agy('trust.ansi'))).toBe(false);
    expect(idleScreen('antigravity', done + '\nUnknown dialog')).toBe(false);
  });

  it.each(['claude', 'codex', 'kimi', 'antigravity'] as const)('rejects an unknown %s layout', kind => {
    expect(idleScreen(kind, 'Done.\n> ')).toBe(false);
  });

  it('does not infer Kimi completion from a bare empty prompt or a failed login', () => {
    expect(idleScreen('kimi', fixture('kimi-empty-screen'))).toBe(false);
    expect(idleScreen('kimi', real('kimi-2.5.1-after'))).toBe(false);
  });
});
