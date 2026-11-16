import { MachineDrain } from '@hornhoof/protocol';
import { z } from 'zod';
import { readState } from './state.js';

/* The server is from before nodes wait for their work, so the installer leaves the node and its turns as they are. */
const SERVER_TOO_OLD = 3;
/* A server that restarts comes back within 5 minutes. Away, it is asked again soon and then less often, each time well
   within the 2 minutes it holds a node for an updater that stopped asking, so the node keeps its place in the wait. */
const AWAY_MS = 5 * 60_000;
const FIRST_TRY_MS = 1000;
const LAST_TRY_MS = 30_000;
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

const Refusal = z.object({ error: z.object({ message: z.string().max(500) }) });
/* How a Hornhoof server from before this wait refuses the path: as any path it does not know, in its own words. A 404 from
   anything else on the way, as the public link with no machine behind it for a moment, says nothing of the server. */
const UnknownPath = z.object({ error: z.object({ code: z.literal('not_found') }) });

/* What the server says, when it says it the usual way: it may be something the person who runs the installer can act on. */
async function refusal(res: Response): Promise<string> {
  const said = Refusal.safeParse(await res.json().catch(() => null));
  return said.success ? said.data.error.message : `The server answered ${res.status}.`;
}

async function ask(server: string, key: string): Promise<Asked> {
  try {
    const res = await fetch(`${server}/api/nodes/update`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(ASK_MS) });
    if (res.status === 404) return UnknownPath.safeParse(await res.json().catch(() => null)).success ? { kind: 'too_old' } : { kind: 'away', why: 'The server answered 404.' };
    if (res.status >= 500) return { kind: 'away', why: `The server answered ${res.status}.` };
    if (!res.ok) return { kind: 'refused', why: await refusal(res) };
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
  /* How long the server has been away, and the pause before the next try: 1, 2, 4, 8 and 16 seconds, then 30 each time. */
  let away = 0;
  let nap = FIRST_TRY_MS;
  for (;;) {
    const asked = await ask(state.server, state.key);
    if (asked.kind === 'too_old') return SERVER_TOO_OLD;
    if (asked.kind === 'answer') {
      if (asked.answer.ready) return 0;
      away = 0;
      nap = FIRST_TRY_MS;
      said = sayOnce(io, saying(asked.answer.drain), said);
      await sleep(asked.answer.pollAfterMs);
      continue;
    }
    if (asked.kind === 'refused' || away >= AWAY_MS) {
      io.stderr.write(`Could not ask ${state.server} about this node: ${asked.why}\n`);
      return 1;
    }
    const pause = Math.min(nap, AWAY_MS - away);
    away += pause;
    nap = Math.min(nap * 2, LAST_TRY_MS);
    await sleep(pause);
  }
}
