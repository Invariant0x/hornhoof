import { MachineDrain } from '@hornhoof/protocol';
import { z } from 'zod';
import { readState } from './state.js';

/* The server is from before nodes wait for their work, so the installer leaves the node and its turns as they are. */
const SERVER_TOO_OLD = 3;
/* A server that restarts comes back within these tries, 5 minutes in all. */
const TRIES = 60;
const TRY_MS = 5000;
const ASK_MS = 30_000;

const Answer = z.object({ ready: z.boolean(), drain: MachineDrain, pollAfterMs: z.number().positive() });
type Io = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
type Asked = { kind: 'answer'; answer: z.infer<typeof Answer> } | { kind: 'too_old' } | { kind: 'refused' | 'away'; why: string };

function saying(drain: MachineDrain): string {
  if (drain.state === 'restarting') return '';
  const work = `${drain.turnsLeft} ${drain.turnsLeft === 1 ? 'turn' : 'turns'} and ${drain.partsLeft} test ${drain.partsLeft === 1 ? 'part' : 'parts'}`;
  if (drain.state === 'waiting') return `Waiting for ${work} on this node to end, until ${drain.until}.`;
  return `The wait ran out with ${work} still running. Nothing was stopped, Operations was told, and it tries again at ${drain.retryAt}.`;
}

function sayOnce(io: Io, line: string, said: string): string {
  if (line !== said) io.stdout.write(line + '\n');
  return line;
}

async function ask(server: string, key: string): Promise<Asked> {
  try {
    const res = await fetch(`${server}/api/nodes/update`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(ASK_MS) });
    if (res.status === 404) return { kind: 'too_old' };
    if (res.status >= 500) return { kind: 'away', why: `The server answered ${res.status}.` };
    if (!res.ok) return { kind: 'refused', why: `The server answered ${res.status}.` };
    return { kind: 'answer', answer: Answer.parse(await res.json()) };
  } catch (err) {
    return { kind: 'away', why: err instanceof Error ? err.message : String(err) };
  }
}

/* Asks the server to let this node's work end, and returns when it says the node is free: 0, and the installer replaces
   the node. Anything else leaves the node running. The server holds the node while this asks, and lets go of it soon
   after this stops. */
export async function waitUpdate(dir: string, io: Io, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<number> {
  const state = readState(dir);
  if (!state) {
    io.stderr.write('This node has no key.\n');
    return 1;
  }
  let said = '';
  let tries = 0;
  for (;;) {
    const asked = await ask(state.server, state.key);
    if (asked.kind === 'too_old') return SERVER_TOO_OLD;
    if (asked.kind === 'answer') {
      if (asked.answer.ready) return 0;
      tries = 0;
      said = sayOnce(io, saying(asked.answer.drain), said);
      await sleep(asked.answer.pollAfterMs);
      continue;
    }
    tries += 1;
    if (asked.kind === 'refused' || tries >= TRIES) {
      io.stderr.write(`Could not ask ${state.server} about this node: ${asked.why}\n`);
      return 1;
    }
    await sleep(TRY_MS);
  }
}
