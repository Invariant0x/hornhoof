import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeExit, NodeStopReason, type NodeMessage } from '@hornhoof/protocol';
import { z } from 'zod';
import { nodeLog, nodeLogStream } from './node-log.js';

const JOURNAL = 'node-runtime.json';
const INTENT = 'node-stop-intent.json';
const State = z.object({ startedAt: z.iso.datetime(), oomKills: z.number().int().nonnegative().nullable(), log: z.string(), exit: NodeExit.nullable() });
const Intent = z.object({ startedAt: z.iso.datetime(), reason: NodeStopReason });
type State = z.infer<typeof State>;
type Input = { dir: string; startedAt: string; secrets(): string[]; write(line: string): void; readOom?(): number | null };
type Lifecycle = { previous: NodeExit; log(line: string): void; tail(): string; stop(reason: NodeStopReason): NodeExit };

export function stopNode(life: Lifecycle, send: ((message: NodeMessage) => boolean) | null, startedAt: string, reason: NodeStopReason): void {
  const exit = life.stop(reason);
  send?.({ type: 'node.stopping', startedAt, exit });
}

/* A corrupt or missing record says nothing about the last exit. Limit reads even if a file was damaged. */
function read(path: string): unknown {
  try {
    if (statSync(path).size > 128 * 1024) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function keep(path: string, value: unknown): void {
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify(value) + '\n', { mode: 0o600 });
  chmodSync(pending, 0o600);
  renameSync(pending, path);
}

function journalWriter(path: string, failed: () => void): (value: State) => void {
  let warned = false;
  return value => {
    try {
      keep(path, value);
    } catch {
      if (!warned) {
        warned = true;
        failed();
      }
    }
  };
}

function oomKills(): number | null {
  try {
    const value = /^oom_kill (\d+)$/m.exec(readFileSync('/sys/fs/cgroup/memory.events', 'utf8'));
    return value ? Number(value[1]) : null;
  } catch {
    return null;
  }
}

const unknownExit = (): NodeExit => ({ kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' });
const wasOom = (before: number | null, now: number | null): boolean => before !== null && now !== null && now > before;
const memoryEvidence = (before: number | null, now: number | null): string => wasOom(before, now) ? `Memory cgroup OOM kills: ${before} -> ${now}.` : '';

function previousExit(state: State | null, oom: number | null, secrets: string[]): NodeExit {
  if (!state) return unknownExit();
  if (state.exit) return { ...state.exit, log: nodeLog(state.exit.log, secrets) };
  return { startedAt: state.startedAt, at: null, kind: 'unplanned', reason: 'unclean_exit', log: nodeLog(`${state.log}\n${memoryEvidence(state.oomKills, oom)}`.trimEnd(), secrets) };
}

function stopReason(dir: string, startedAt: string, fallback: NodeStopReason): NodeStopReason {
  const intent = Intent.safeParse(read(join(dir, INTENT)));
  return intent.success && intent.data.startedAt === startedAt ? intent.data.reason : fallback;
}

/* The installer records intent in the running generation. Only its process's stop() can record a completed stop. */
export function prepareNodeStop(dir: string, reason: NodeStopReason): void {
  const state = State.parse(read(join(dir, JOURNAL)));
  if (state.exit) throw new Error('The node has already stopped.');
  keep(join(dir, INTENT), { startedAt: state.startedAt, reason: NodeStopReason.parse(reason) });
}

export function nodeLifecycle(input: Input): Lifecycle {
  const { dir, startedAt, secrets, write } = input;
  const oom = (input.readOom ?? oomKills)();
  const parsed = State.safeParse(read(join(dir, JOURNAL)));
  const previous = previousExit(parsed.success ? parsed.data : null, oom, secrets());
  let state: State = { startedAt, oomKills: oom, log: '', exit: null };
  const cleanLine = nodeLogStream();
  const save = journalWriter(join(dir, JOURNAL), () => {
    const warning = 'Node lifecycle journal could not be saved; restart evidence may be missing.';
    state = { ...state, log: nodeLog(`${state.log}\n${warning}`, secrets()) };
    write(warning);
  });
  const persist = () => save(state);
  persist();
  const log = (line: string): void => {
    if (state.exit) return;
    const clean = cleanLine(line, secrets());
    state = { ...state, log: nodeLog(`${state.log}\n${clean}`.trimStart(), secrets()) };
    persist();
    write(clean);
  };
  const stop = (fallback: NodeStopReason): NodeExit => {
    if (state.exit) return state.exit;
    const reason = stopReason(dir, startedAt, fallback);
    log(`Node stopping: ${reason}.`);
    const exit: NodeExit = { startedAt, at: new Date().toISOString(), kind: 'planned', reason, log: state.log };
    state = { ...state, exit };
    persist();
    return exit;
  };
  log(`Node started at ${startedAt}.`);
  return { previous, log, tail: () => state.log, stop };
}
