import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNED_OUT as AGY_SIGNED_OUT } from '../src/providers/antigravity.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, home, host, sent, setUp, job, codexJob, kimiJob, tmux, until } from './terminal-host-helpers.js';

/* What the program of Hornhoof's turn does goes to Hornhoof as it changes, and again while nothing changes. */
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key), signedOut: AGY_SIGNED_OUT });
const jobs = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
type Told = Extract<NodeMessage, { type: 'job.program' }>;
const told = (jobId: string) => sent.filter((m): m is Told => m.type === 'job.program' && m.jobId === jobId);
const said = (m: Told) => (m.tool ? `${m.state} ${m.tool}` : m.state);
/* Whether these came in this order, among others. */
function inOrder(all: string[], some: string[]): boolean {
  let at = 0;
  for (const s of some) {
    at = all.indexOf(s, at) + 1;
    if (!at) return false;
  }
  return true;
}

describe.skipIf(!hasTmux)("what a turn's program does, as the host tells Hornhoof", () => {
  afterEach(async () => host?.stop());

  it.each([
    ['claude', ['thinking', 'tool Bash', 'asking AskUserQuestion']],
    ['codex', ['thinking', 'tool Bash']],
    ['kimi', ['thinking', 'tool Bash']],
    ['antigravity', ['thinking', 'tool run_command']],
  ] as const)('%s thinks and runs a tool, each change told once, with since when', async (kind, seen) => {
    await setUp({ lookMs: 200 });
    const jobId = `job-work-${kind}`;
    const started = Date.now();
    expect(await host.run(jobs[kind](`work-${kind}`, 'WORK here', { jobId }))).toMatchObject({ ok: true, result: expect.stringContaining(kind === 'antigravity' ? 'FINISHED' : 'echo: WORK here') });
    const messages = told(jobId);
    expect(inOrder(messages.map(said), [...seen])).toBe(true);
    /* Nothing changed between two messages a minute apart only. */
    messages.slice(1).forEach((m, i) => expect(said(m)).not.toBe(said(messages[i]!)));
    for (const m of messages) {
      expect(m.since).toBeGreaterThanOrEqual(started);
      expect(m.screenAt).toBeGreaterThanOrEqual(started);
    }
  });

  it('tells the same again while nothing changes, as often as it is due, and no more', async () => {
    await setUp({ lookMs: 100, reportMs: 500 });
    const stop = new AbortController();
    const run = host.run(kimiJob('again', 'HANG here', { jobId: 'job-again', signal: stop.signal }));
    await until(() => told('job-again').length > 0, 10_000);
    await new Promise(r => setTimeout(r, 2600));
    stop.abort();
    await run;
    const messages = told('job-again');
    expect(messages.length).toBeGreaterThanOrEqual(5);
    expect(messages.length).toBeLessThanOrEqual(7);
    expect(new Set(messages.map(said))).toEqual(new Set(['thinking']));
    expect(new Set(messages.map(m => m.since)).size).toBe(1);
  });

  it.each([
    ['claude', 'WORK here'],
    ['codex', 'WORK here'],
    ['kimi', 'Welcome to Kimi Code'],
    ['antigravity', 'WORK here'],
  ] as const)('%s whose program is killed mid-turn is told gone, with the signal and its last screen', async (kind, shown) => {
    /* What the screen shows of a secret, as of the prompt here, stays on the node. */
    await setUp({ lookMs: 200, secrets: () => ['WORK here'] });
    const jobId = `job-gone-${kind}`;
    const run = host.run(jobs[kind](`gone-${kind}`, 'WORK here', { jobId }));
    await until(() => told(jobId).length > 0, 10_000);
    process.kill((await tmux.programPid(`a-gone-${kind}`))!, 'SIGKILL');
    expect(await run).toMatchObject({ ok: false });
    const gone = told(jobId).at(-1)!;
    expect(gone).toMatchObject({ state: 'gone', screen: expect.stringContaining(shown.replace('WORK here', '[hidden]')) });
    /* The program or the shell that ran it: tmux tells the signal, or the code a shell gives for it. */
    expect([{ exitCode: null, signal: 'SIGKILL' }, { exitCode: 137, signal: null }]).toContainEqual({ exitCode: gone.exitCode, signal: gone.signal });
    expect(gone.screen).not.toMatch(/\x1b|WORK here/);
  });

  it('tells a program that exits mid-turn gone, with its exit code', async () => {
    await setUp({ lookMs: 200 });
    expect(await host.run(job('exits', 'EXIT', { jobId: 'job-exits' }))).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(told('job-exits').at(-1)).toMatchObject({ state: 'gone', exitCode: 3, signal: null, screen: expect.stringMatching(/fake claude new .*\n❯ EXIT/) });
  });
});
