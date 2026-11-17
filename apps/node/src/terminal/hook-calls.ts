type HookReply = { status: number; text: string };
type Remembered = { event: string; answer: Promise<HookReply>; done: boolean };
type Recent = { stops: Map<string, Remembered>; others: Map<string, Remembered> };
const MAX_CALLS = 1024;

/* Keep the last stop ids across idle gaps. Frequent status calls have their own bound and cannot evict a stop. Pending
   calls are never evicted: their first attempt may still finish after the client has already retried. */
export class HookCalls {
  private readonly agents = new Map<string, Recent>();

  run(key: string, event: string, call: string | undefined, apply: () => Promise<string>): Promise<HookReply> {
    if (call === undefined) return applied(apply);
    const recent = this.forAgent(key);
    const known = recent.stops.get(call) ?? recent.others.get(call);
    if (known) return known.event === event ? known.answer : Promise.resolve({ status: 409, text: '' });
    const calls = event === 'stop' ? recent.stops : recent.others;
    if (!makeRoom(calls)) return Promise.resolve({ status: 429, text: '' });
    const entry: Remembered = { event, answer: applied(apply), done: false };
    calls.set(call, entry);
    void entry.answer.then(() => { entry.done = true; });
    return entry.answer;
  }

  private forAgent(key: string): Recent {
    const recent = this.agents.get(key) ?? { stops: new Map<string, Remembered>(), others: new Map<string, Remembered>() };
    this.agents.set(key, recent);
    return recent;
  }
}

function makeRoom(calls: Map<string, Remembered>): boolean {
  if (calls.size < MAX_CALLS) return true;
  for (const [id, call] of calls) {
    if (!call.done) continue;
    calls.delete(id);
    return true;
  }
  return false;
}

async function applied(apply: () => Promise<string>): Promise<HookReply> {
  try {
    return { status: 200, text: await apply() };
  } catch {
    return { status: 502, text: '' };
  }
}
