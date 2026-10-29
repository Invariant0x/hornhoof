#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits, NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { connect } from './connection.js';
import { runJob, type ProviderAdapter } from './runner.js';
import { isRemoved, markRemoved, readState } from './state.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const LOGIN_CHECK_MS = 10_000;

type RunOptions = { dir: string; adapter: ProviderAdapter; log?: (line: string) => void; loginCheckMs?: number };

/* The node's life: stay connected, run jobs, report the sign-in state and the limits, clean up when removed. */
export async function runNode({ dir, adapter, log = console.log, loginCheckMs = LOGIN_CHECK_MS }: RunOptions): Promise<{ stop(): void }> {
  if (isRemoved(dir)) {
    log('This node was removed in Hornhoof.');
    return { stop() {} };
  }
  const state = readState(dir);
  if (!state) throw new Error(`No node settings in ${dir}/node.json. Run the install command from Hornhoof again.`);

  const running = new Set<string>();
  /* Messages that could not be sent while offline. They go out right after the next hello. */
  const outbox: NodeMessage[] = [];
  let send: ((m: NodeMessage) => boolean) | null = null;
  let loggedIn = await adapter.loggedIn();
  let limits: Limits | null = null;
  let stopped = false;

  const emit = (m: NodeMessage) => {
    if (!send?.(m)) outbox.push(m);
  };
  const status = () => emit({ type: 'status', loggedIn, limits });

  const conn = connect({
    url: state.server.replace(/^http/, 'ws') + '/api/nodes/socket',
    key: state.key,
    onOpen(next) {
      send = next;
      /* Finished jobs waiting in the outbox still count as running, so the server does not give up on them. */
      const pending = outbox.flatMap(m => (m.type === 'job.done' ? [m.jobId] : []));
      next({ type: 'hello', version: VERSION, loggedIn, running: [...running, ...pending] });
      for (const m of outbox.splice(0)) emit(m);
    },
    onMessage: m => void handle(m),
    onRefused: () => log('Hornhoof does not know this machine any more. Run the install command from Hornhoof again to reconnect.'),
  });

  async function handle(m: ServerMessage) {
    if (m.type === 'remove') {
      for (const sub of ['home', 'work']) rmSync(join(dir, sub), { recursive: true, force: true });
      markRemoved(dir);
      emit({ type: 'removed' });
      log('This node was removed in Hornhoof.');
      stop();
      return;
    }
    if (running.has(m.jobId)) return;
    running.add(m.jobId);
    emit({ type: 'job.started', jobId: m.jobId });
    const tracked: ProviderAdapter = {
      ...adapter,
      run: async input => {
        const res = await adapter.run(input);
        if (res.limits) limits = res.limits;
        return res;
      },
    };
    const done = await runJob(tracked, m, dir);
    running.delete(m.jobId);
    emit(done);
    if (done.error === 'not_logged_in') loggedIn = false;
    status();
  }

  /* While signed out, look again now and then, so the person sees Ready soon after signing in. */
  const timer = setInterval(async () => {
    if (loggedIn || stopped) return;
    if (await adapter.loggedIn()) {
      loggedIn = true;
      status();
    }
  }, loginCheckMs);
  timer.unref();

  function stop() {
    stopped = true;
    clearInterval(timer);
    /* Let the last message leave before the socket closes. */
    setTimeout(() => conn.close(), 50);
  }
  return { stop };
}
