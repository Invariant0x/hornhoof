import { setTimeout as pause } from 'node:timers/promises';
import type { NodeMessage } from '@hornhoof/protocol';
import { expect, vi } from 'vitest';
import type { RunResult } from '../src/runner.js';
import type { Tmux } from '../src/terminal/tmux.js';

/* Initial idle is legitimate until the program accepts the prompt. Every report after acceptance counts. */
export function acceptedReports(sent: NodeMessage[], jobId: string) {
  const all = sent.filter((m): m is Extract<NodeMessage, { type: 'job.program' }> => m.type === 'job.program' && m.jobId === jobId);
  const accepted = all.findIndex(m => m.state === 'thinking' || m.state === 'tool');
  return accepted < 0 ? [] : all.slice(accepted);
}

/* Advance the grace period only after tmux actually delivered Escape. Its I/O keeps using real time. */
export async function cancelTurn(tmux: Tmux, stop: AbortController, run: Promise<RunResult>): Promise<RunResult> {
  const command = tmux.run.bind(tmux);
  let escaped = false;
  const pressed = vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
    const out = await command(args, input);
    if (args[0] === 'send-keys' && args.includes('Escape')) escaped = true;
    return out;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    stop.abort();
    for (let n = 0; !escaped && n < 200; n++) {
      await vi.advanceTimersByTimeAsync(100);
      await pause(10);
    }
    expect(escaped).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    return await run;
  } finally {
    vi.useRealTimers();
    pressed.mockRestore();
  }
}
