/* Whether the page can reach the server, and what it tells the person when it cannot (#1938). The server being away must never
   read as a page that is missing: a hop that is not Hornhoof answers 404 with a page of its own (the public link's relay does
   when no keeper holds the name), the front or the keeper answers 502 with no live server behind it, a restart refuses the
   browser's own request, and an update answers 503 "maintenance". Each tells the page the server is away, and the page asks
   it again with a growing wait until the server answers, then asks every screen to fetch what it shows anew, with no reload. */

export type Away = 'lost' | 'updating';
/* What the layer over the page shows: nothing while the server answers, or why it does not. trying: a look is on its way.
   since: when the server was first missed, and nextAt: when the next look comes, both in ms of the page's clock, null where
   there is none. */
export type Link = { away: Away | null; trying: boolean; since: number | null; nextAt: number | null };

/* Puts fn in the set and gives back the way to take it out. */
export function joined(set: Set<() => void>, fn: () => void): () => void {
  set.add(fn);
  return () => void set.delete(fn);
}

type Said = { code?: unknown; reason?: unknown };

/* Hornhoof's own words in an answer, which every error of the server and of its front and keeper carries. A hop that is
   not Hornhoof has none. */
function saidIn(data: unknown): Said | null {
  const said = (data as { error?: Said } | null | undefined)?.error;
  return said && typeof said === 'object' && typeof said.code === 'string' ? said : null;
}

/* An answer in none of Hornhoof's words that says "not found" or "failed": it came from a hop in front of the server, not
   from it, since the server's own 404 and 500 always carry an error with a code. data is what the body said: null for no
   body, anything for a body that was read whole, and undefined for one that broke off, which says nothing of who sent it. */
export const fromAHop = (status: number, data: unknown): boolean => (status === 404 || status >= 500) && data !== undefined && saidIn(data) === null;

/* Whether an answer tells the server is away, and if it does, whether that is an update. */
export function awayOf(status: number, data: unknown): Away | null {
  const said = saidIn(data);
  if (!said) return fromAHop(status, data) ? 'lost' : null;
  if (said.reason === 'maintenance') return 'updating';
  /* The front or the keeper speaking for a server that is not there; a server's own refusal is not that. */
  return status >= 500 && (said.reason === 'starting' || said.reason === 'no_leader') ? 'lost' : null;
}

/* The wait before the next look at the server, which grows to the cap and starts over once it answers. */
const WAITS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
/* A look that does not answer within this is a look that failed. */
const LOOK_MS = 8_000;
/* A failed request is a reason to look, no more often than this: a hop that keeps answering wrong for one path while the
   server answers the look must not make the page look without end. */
const SUSPECT_EVERY_MS = 5_000;
/* What the server answers to anyone, signed in or not; an answer in its own words, 404 included, is the server. */
const LOOK_AT = '/api/build';

let link: Link = { away: null, trying: false, since: null, nextAt: null };
let phase: 'ok' | 'looking' | 'away' = 'ok';
let kind: Away = 'lost';
let updateRuns = false;
let tries = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/* When this outage began and when the next look comes; null while none stands. */
let since: number | null = null;
let nextAt: number | null = null;
let lookedAt = Number.NEGATIVE_INFINITY;
/* The look on its way, if any, by its number: the answer of one that was given up for a newer look counts for nothing. */
let looks = 0;
let busy = false;
const watchers = new Set<() => void>();
const returns = new Set<() => void>();

const shown = (): Away => (kind === 'updating' || updateRuns ? 'updating' : 'lost');

function publish(): void {
  const next: Link = { away: phase === 'away' ? shown() : null, trying: phase !== 'ok' && busy, since, nextAt };
  if (next.away === link.away && next.trying === link.trying && next.since === link.since && next.nextAt === link.nextAt) return;
  link = next;
  for (const watch of [...watchers]) watch();
}

/* What the server says to a look, or null when it says nothing the page can use. */
async function looked(): Promise<{ status: number; data: unknown } | null> {
  try {
    const res = await fetch(LOOK_AT, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(LOOK_MS) });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      /* A page of a hop's own: no words of Hornhoof's, which awayOf reads as away. */
    }
    return { status: res.status, data };
  } catch {
    return null;
  }
}

function back(): void {
  const wasShown = phase === 'away';
  phase = 'ok';
  tries = 0;
  kind = 'lost';
  since = null;
  nextAt = null;
  if (timer) clearTimeout(timer);
  timer = null;
  publish();
  /* What the screens asked meanwhile was refused: they all ask again. A blip that never showed the layer left each failed
     request to say so by itself. */
  if (wasShown) for (const done of [...returns]) done();
}

function wait(): void {
  if (timer) clearTimeout(timer);
  const ms = WAITS_MS[Math.min(tries, WAITS_MS.length - 1)]!;
  tries++;
  nextAt = Date.now() + ms;
  timer = setTimeout(() => void look(), ms);
}

async function look(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  nextAt = null;
  const mine = ++looks;
  busy = true;
  publish();
  const answer = await looked();
  if (mine !== looks) return;
  busy = false;
  lookedAt = Date.now();
  const away = answer ? awayOf(answer.status, answer.data) : 'lost';
  if (away === null) return back();
  /* Once an update was heard of, the layer keeps saying so through the restart that follows it. */
  if (away === 'updating') kind = 'updating';
  phase = 'away';
  since ??= Date.now();
  wait();
  publish();
}

/* A request met no server: the browser's own request failed, or the answer was a hop's or the front's or the keeper's for a
   server that is not there, or a refusal for an update. The page first looks, so a request that failed alone, or a change
   refused while reads still go through, draws nothing. why: what the request heard, which the layer keeps saying through
   the restart that follows an update. */
function lost(why: Away = 'lost'): void {
  if (why === 'updating' && phase !== 'ok') {
    kind = 'updating';
    publish();
  }
  if (phase !== 'ok' || Date.now() - lookedAt < SUSPECT_EVERY_MS) return;
  if (why === 'updating') kind = 'updating';
  phase = 'looking';
  void look();
}

export const connection = {
  lost,
  /* An update is known to run, from what the update panel reads: while the server is away then, it says so. */
  updateRuns(running: boolean): void {
    updateRuns = running;
    publish();
  },
  /* The person asked to look now. */
  tryNow(): void {
    if (phase === 'ok') return;
    tries = 0;
    void look();
  },
  /* Calls back each time the server answered again after the layer showed; the returned function stops it. */
  onBack: (fn: () => void): (() => void) => joined(returns, fn),
  subscribe: (fn: () => void): (() => void) => joined(watchers, fn),
  snapshot: (): Link => link,
  /* For a test: as it was before the page asked anything. */
  reset(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    looks++;
    busy = false;
    phase = 'ok';
    kind = 'lost';
    since = null;
    nextAt = null;
    updateRuns = false;
    tries = 0;
    lookedAt = Number.NEGATIVE_INFINITY;
    publish();
  },
};
