import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeMessage } from '@hornhoof/protocol';
import { TerminalHost } from '../src/terminal/host.js';
import { fromAgent, socketOf } from '../src/terminal/peer.js';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { job, onClock, passOnClock, untilOnClock } from './terminal-host-helpers.js';
import { procFixture } from './terminal-proc-fixture.js';

/* A node that starts again gets its turns again, and the windows people kept open on its agents open again too, at the same
   moment. tmux never runs: the test stands in for its sessions, in which a launch starts a new session or replaces what its
   pane ran, as tmux's own does, and for the process table the bridge reads (fixtures/hook-owner-restart.json). */
const sample = JSON.parse(readFileSync(new URL('./fixtures/hook-owner-restart.json', import.meta.url), 'utf8')) as {
  agent: string; session: string; before: { program: number; hook: number }; after: { program: number; hook: number; waitingScreen: number }; foreign: number;
};
const KEY = sample.agent;
const NAME = `a-${KEY}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

async function restartedNode() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-restart-')));
  const workDir = join(home, 'work');
  const transcript = claudeTranscript(home, workDir, sample.session);
  const record = (line: object) => { mkdirSync(dirname(transcript), { recursive: true }); appendFileSync(transcript, JSON.stringify(line) + '\n'); };
  const tmux = new Tmux({ env: { HOME: home } });
  /* Each session and the process its pane runs. */
  const panes = new Map<string, number>();
  let hookUrl = '';
  let input = '';
  const submitted: string[] = [];
  const sent: NodeMessage[] = [];
  /* Who calls the bridge: the hook process and the program it runs under, or a process under no program of the agent's. */
  let caller = { program: sample.after.program, hook: sample.after.hook, belongs: true };
  /* While a hook is on its way to the bridge or back the clock stands still; the host's own work runs on it. */
  let transit = 0;
  const clocked = { held: () => transit > 0 };
  const hook = async (event: string, body: object = {}) => {
    transit++;
    try {
      const res = await fetch(`${hookUrl}/${event}`, { method: 'POST', body: JSON.stringify(body), headers: { connection: 'close', 'x-hh-pid': String(caller.hook) } });
      await res.text();
      return res.status;
    } finally { transit--; }
  };
  /* A look for the session that tmux answers late, as on a machine busy starting all its programs again. */
  let late: Promise<void> | null = null;
  vi.spyOn(tmux, 'has').mockImplementation(async name => {
    const there = panes.has(name);
    const waits = late;
    late = null;
    if (waits) await waits;
    return there;
  });
  vi.spyOn(tmux, 'launch').mockImplementation(async (name, spec) => {
    const program = spec.envFile !== undefined;
    panes.set(name, program ? sample.after.program : sample.after.waitingScreen);
    if (!program) return;
    hookUrl = /^HH_BRIDGE='([^']+)'$/m.exec(readFileSync(spec.envFile!, 'utf8'))![1]!;
    record({ type: 'metadata' });
    await hook('start', { session_id: sample.session });
  });
  vi.spyOn(tmux, 'run').mockImplementation(async args => {
    if (args[0] === 'list-panes') return panes.has(args[3]!.slice(1)) ? `${panes.get(args[3]!.slice(1))}\n` : '';
    return args.includes('#{pane_width} #{pane_height}') ? '100 30' : '';
  });
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'clients').mockResolvedValue([]);
  vi.spyOn(tmux, 'livePrograms').mockResolvedValue([]);
  const alive = vi.spyOn(tmux, 'alive').mockImplementation(async name => panes.has(name));
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'attach').mockImplementation(() => Object.assign(new EventEmitter(), { stdin: { write: () => true }, stdout: new EventEmitter(), kill: () => true, killed: false, pid: 0 }) as never);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => `────────────\n❯ ${input}\n────────────\n  ? for shortcuts\n`);
  vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    if (!pressed.includes('Enter') || !input) return;
    submitted.push(input);
    input = '';
    await hook('prompt', { prompt: submitted.at(-1) });
  });
  const proc = procFixture(KEY, () => caller.belongs);
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [], pollMs: 10, enterWaitMs: 50, openMs: 50,
    owner: panes => ({ owns: fromAgent(panes, proc.proc), capture: async peer => ({ acceptedInode: await socketOf(proc.proc, peer) }) }) });
  const handle = host['hook'].bind(host);
  vi.spyOn(host as unknown as { hook: typeof handle }, 'hook').mockImplementation(async (...args) => {
    transit--;
    try { return await handle(...args); } finally { transit++; }
  });
  await host.start();
  proc.listen(host['bridge'], () => caller.program, () => caller.hook);
  const results: Promise<unknown>[] = [];
  cleanups.push(async () => {
    alive.mockResolvedValue(false);
    record({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
    record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    await onClock(Promise.all(results), clocked);
    await onClock(host.stop(), clocked);
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    host, sent, submitted, hook,
    /* The turn the node got again: Hornhoof's turn goes on with the agent's session. */
    run: () => {
      const running = host.run({ ...job(KEY, 'Go on.', { jobId: 'job-again', workDir, sessionId: sample.session }), home });
      results.push(running);
      return running;
    },
    /* A person's window on the agent, which the web opens again as the node comes back. */
    open: () => host.open({ type: 'term.open', termId: 'kept-open', agentKey: KEY, cols: 100, rows: 30, write: false }),
    answersLate: () => {
      let release = () => {};
      late = new Promise<void>(resolve => { release = resolve; });
      return () => release();
    },
    pane: () => panes.get(NAME),
    calls: (who: typeof caller) => { caller = who; },
    until: (check: () => boolean) => untilOnClock(check, clocked),
    on: <T>(promise: Promise<T>) => onClock(promise, clocked),
    pass: (ms: number) => passOnClock(ms, clocked),
  };
}

const rejected = (sent: NodeMessage[]) => sent.filter(m => m.type === 'agent.hook_rejected');

describe('hooks of a program the node started again', () => {
  it("keep the program in its own pane when a window opens the agent's session as its turn starts, so its hooks go through", async () => {
    const node = await restartedNode();
    const release = node.answersLate();
    const opening = node.open();
    void node.run();
    await node.pass(500);
    release();
    await node.on(opening);
    await node.until(() => node.submitted.length > 0);
    expect(node.pane()).toBe(sample.after.program);
    expect(await node.hook('tool', { tool_name: 'Bash', tool_use_id: 'call-1' })).toBe(200);
    expect(rejected(node.sent)).toEqual([]);
  });

  it('still refuse a process of the same user outside the agent\'s program, and the program from before the restart', async () => {
    const node = await restartedNode();
    void node.run();
    await node.until(() => node.submitted.length > 0);
    expect(node.pane()).toBe(sample.after.program);
    node.calls({ program: sample.after.program, hook: sample.foreign, belongs: false });
    expect(await node.hook('stop')).toBe(403);
    node.calls({ ...sample.before, belongs: true });
    expect(await node.hook('status')).toBe(403);
    expect(rejected(node.sent).map(m => m.type === 'agent.hook_rejected' && [m.event, m.reason])).toEqual([['stop', 'owner check failed'], ['status', 'owner check failed']]);
  });
});
