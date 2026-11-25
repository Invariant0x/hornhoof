import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { ApiFailure, isAway } from '../api';
import { askAgainAfter } from '../backoff';
import { connection } from '../connection';
import { errorText, useT, type Messages } from '../i18n';
import { LogoMark } from './icons';
import { ServiceLoader, useServiceView } from './ServiceRoad';

/* The timeline of one load, from the style book (1.5, section 4, #1611, #2099). What is known is drawn at once; the ring shows
   400 ms after the load is asked, so a fast load never shows one, and once shown it stays at least 500 ms, so it never blinks.
   A load that has no answer after 30 s says nothing of it: it is asked again by itself, and the page looks at whether the
   server answers, which the service road says if it does not. It is one limit of the whole load, not one per request, and
   Retry, where a failure with a reason stands, starts it over with the ring at once, as the person asked. */
export const RING_DELAY_MS = 400;
export const RING_MIN_MS = 500;
export const STUCK_MS = 30_000;

/* A server without a list or a sum yet answers that it has none (404): a part that came, empty. */
export const noneYet = (f: unknown) => f instanceof ApiFailure && f.status === 404;

/* A part of a screen's data: undefined or null until its first answer; failure: why its last ask failed; load asks again;
   cancel, where it can, stops the ask still running. quiet: another part of the same screen already says its failure and
   its time, so here it is only awaited, and the screen says it once. */
export type LoadPart = { data: unknown; failure: unknown; load(): unknown; cancel?(): void; quiet?: boolean };

/* Where a screen's load is: coming, failed with why, or all come. ring: the ring may show now. asked: how many times Retry
   asked again. The server being away is no failure of a load: the load keeps coming, and the service road says why. */
export type Load = { phase: 'loading' | 'failed' | 'done'; ring: boolean; failure: unknown; asked: number; retry(): void };

/* A held list holds at most this many rows. */
export const MAX_HELD_ROWS = 40;

const ROWS_KEY = 'hh-held-rows:';

/* How many rows a list showed last in this tab, kept per list (its view, filter, department or person) for the session:
   the list holds that many while it loads again. The tab may keep nothing, as a private window does; then none is known. */
function keptRows(list: string): number | null {
  try {
    const rows = Number(sessionStorage.getItem(ROWS_KEY + list));
    return rows > 0 ? Math.min(rows, MAX_HELD_ROWS) : null;
  } catch {
    return null;
  }
}

function keepRows(list: string, rows: number): void {
  try {
    sessionStorage.setItem(ROWS_KEY + list, String(Math.max(1, Math.min(rows, MAX_HELD_ROWS))));
  } catch {
    /* Nothing kept: the list fills what is in view. */
  }
}

/* The rows a list holds while it loads: its last count in this tab, or null for as many as fill what is in view. shown: the
   rows it shows once loaded, which it keeps for the next time. */
export function useHeldRows(list: string, shown: number | null): number | null {
  useEffect(() => {
    if (shown !== null) keepRows(list, shown);
  }, [list, shown]);
  return keptRows(list);
}

const missingOf = (parts: LoadPart[]) => parts.filter(p => p.data === undefined || p.data === null);

type Seen = { failed: unknown; waiting: boolean; timed: boolean };

/* How many times Retry asked, and whether the last wait began with it. */
type Asked = { round: number; byRetry: boolean };

/* Where the parts that have not come are: the first failure to say, if any, then whether they are still coming, and whether
   the limit counts. A failure from before the last Retry no longer counts, as the part is asked again. A part that waits for
   the server to be back, which is no failure to say, or a quiet part, which another part of the screen says, is still coming,
   and no limit counts while it waits. */
function seen(missing: LoadPart[], before: Set<unknown>): Seen {
  const failures = missing.map(p => (p.quiet || p.failure === undefined || isAway(p.failure) ? null : p.failure));
  const failed = failures.find(f => f && !before.has(f)) ?? null;
  const saidElsewhere = missing.some((p, i) => p.quiet || (p.failure && !failures[i]));
  const waiting = missing.length > 0 && !failed;
  return { failed, waiting, timed: waiting && !saidElsewhere };
}

type Times = { ring: boolean; holding: boolean; stuck: number };

/* The marks of a wait, each set by its own timer: the ring showed, it showed its least time, how many times the load went
   30 s with no answer. Timers alone move them, so a load follows whatever clock runs them. */
type Marks = { ring: boolean; least: boolean; stuck: number };

const NOT_YET: Marks = { ring: false, least: false, stuck: 0 };

type SetMarks = Dispatch<SetStateAction<Marks>>;
type Timer = ReturnType<typeof setTimeout>;

/* Shows the ring now and holds it for its least time, in the one least timer of the load. */
function showRing(setMarks: SetMarks, least: MutableRefObject<Timer | undefined>) {
  setMarks(m => ({ ...m, ring: true, least: false }));
  clearTimeout(least.current);
  least.current = setTimeout(() => setMarks(m => ({ ...m, least: true })), RING_MIN_MS);
}

/* A wait's timers from its start: the ring after its delay, or at once when Retry asked; and, where the limit counts, one
   mark each time the load goes 30 s with no answer. */
function startTimes(setMarks: SetMarks, least: MutableRefObject<Timer | undefined>, byRetry: boolean, timed: boolean): Timer[] {
  const ring = () => showRing(setMarks, least);
  setMarks(NOT_YET);
  if (byRetry) ring();
  const timers = byRetry ? [] : [setTimeout(ring, RING_DELAY_MS)];
  const stuck = () => {
    setMarks(m => ({ ...m, stuck: m.stuck + 1 }));
    timers.push(setTimeout(stuck, STUCK_MS));
  };
  if (timed) timers.push(setTimeout(stuck, STUCK_MS));
  return timers;
}

/* The ring, the holding of data and the limits of a load. A wait starts them, the ring at once when Retry asked; data that
   came while the ring showed waits until it showed its least time, counted from the moment it showed. */
function useTimes(waiting: boolean, timed: boolean, asked: Asked): Times {
  const [marks, setMarks] = useState<Marks>(NOT_YET);
  const least = useRef<Timer>(undefined);
  useEffect(() => () => clearTimeout(least.current), []);
  useLayoutEffect(() => {
    if (!waiting) return;
    const timers = startTimes(setMarks, least, asked.byRetry, timed);
    return () => timers.forEach(clearTimeout);
  }, [waiting, timed, asked]);
  const holding = !waiting && marks.ring && !marks.least;
  return { ring: waiting ? marks.ring : holding, holding, stuck: waiting ? marks.stuck : 0 };
}

function phaseOf(failed: unknown, times: Times, waiting: boolean): Pick<Load, 'phase' | 'ring' | 'failure'> {
  if (failed) return { phase: 'failed', ring: false, failure: failed };
  if (waiting || times.holding) return { phase: 'loading', ring: times.ring, failure: null };
  return { phase: 'done', ring: false, failure: null };
}

/* Each id of a failure, to tell a new failure of a part from the one it had. */
const failureIds = new WeakMap<object, number>();
let lastFailureId = 0;
const idOfFailure = (failure: unknown): number => {
  if (typeof failure !== 'object' || failure === null) return 0;
  if (!failureIds.has(failure)) failureIds.set(failure, ++lastFailureId);
  return failureIds.get(failure)!;
};

/* A part that failed because the server is away is asked again by itself, after a growing wait, until it comes: nothing for
   the person to press, and nothing to say, since the service road says it. A part an update refused does not ask on a timer:
   the page that asked is the old build until the update panel has looked at the build the server runs now, and it asks all
   its parts again, by the connection coming back, only once it has (or reloads, where the build differs). */
const refusedByUpdate = (failure: unknown): boolean => failure instanceof ApiFailure && failure.reason === 'maintenance';

function useAskAgainWhileAway(missing: LoadPart[]): void {
  const away = missing.filter(p => !p.quiet && isAway(p.failure) && !refusedByUpdate(p.failure));
  const tries = useRef(0);
  const asking = useRef(away);
  asking.current = away;
  const signature = away.map(p => idOfFailure(p.failure)).join(',');
  useEffect(() => {
    if (signature === '') {
      tries.current = 0;
      return;
    }
    const timer = setTimeout(() => {
      tries.current++;
      for (const p of asking.current) p.load();
    }, askAgainAfter(tries.current));
    return () => clearTimeout(timer);
  }, [signature]);
}

/* A screen's data once its load is done, else null: what the screen shows in place of its held room. */
export const doneOf = <T,>(data: T | null, load: Load): T | null => (load.phase === 'done' ? data : null);

/* One load of a screen from its parts. Show its data once its phase is done, not as soon as the data is there, so the ring
   keeps its least time. */
export function useLoad(parts: LoadPart[]): Load {
  const [asked, setAsked] = useState<Asked>({ round: 0, byRetry: false });
  const before = useRef(new Set<unknown>());
  const missing = missingOf(parts);
  const { failed, waiting, timed } = seen(missing, before.current);
  const times = useTimes(waiting, timed, asked);
  useAskAgainWhileAway(missing);
  /* 30 s with no answer: the parts still missing are asked again, and the page looks at whether the server answers. */
  const again = useRef(missing);
  again.current = missing;
  useEffect(() => {
    if (times.stuck === 0) return;
    connection.lost();
    for (const p of again.current) {
      p.cancel?.();
      p.load();
    }
  }, [times.stuck]);
  const retry = () => {
    for (const p of missing) {
      if (p.failure) before.current.add(p.failure);
      p.cancel?.();
      p.load();
    }
    setAsked(a => ({ round: a.round + 1, byRetry: true }));
  };
  return { ...phaseOf(failed, times, waiting), asked: asked.round, retry };
}

/* A failure of a load said on top of the page: only once the data came. Before that, the load says it where the data would
   stand. */
export const onTop = (data: unknown, failure: unknown): unknown => (data === undefined || data === null ? null : failure);

/* What failed and what to do, each one whole sentence: an error answer that names its own reason, or any other error answer.
   The server being away is no failure of a load, so no sentence says it. */
export function failWords(t: Messages, failure: unknown): [string, string] {
  const words = t.load;
  if (failure instanceof ApiFailure && failure.status < 500 && failure.code !== 'internal') return [errorText(t, failure), words.hint.server];
  return [words.failed.server, words.hint.server];
}

/* The 8 px idle bar that holds a piece of text still coming, in its line. */
export function Idle({ w }: { w: string }) {
  return <span className="ph" style={{ '--w': w } as CSSProperties} aria-hidden="true" />;
}

/* The ring with its words, where a part of a screen is still coming (inline), or in the middle of a screen's body on its
   first open, under the static mark (screen). Before the ring's time it holds its room unseen. live: it is the screen's one
   status; a second part of the same screen shows its words with no live role. */
type BusyProps = { ring: boolean; words?: ReactNode; form?: 'inline' | 'screen'; live?: boolean };

export function Busy({ ring, words, form = 'inline', live = true }: BusyProps) {
  const t = useT();
  const serviceSays = useServiceView() !== null;
  const said = words ?? t.common.loading;
  const role = live ? 'status' : undefined;
  /* While a service state stands, a page area with nothing to show says it in place: the logo and the same line of the road.
     A small part of a card keeps its ring and its own words. */
  if (serviceSays && form === 'screen') return <ServiceLoader live={live} />;
  if (form === 'screen') {
    return (
      <div className={ring ? 'load-boot' : 'load-boot unseen'} role={role}>
        <LogoMark className="load-mark" />
        <span className="spinner lg" aria-hidden="true" />
        <p className="load-boot-t">{said}</p>
      </div>
    );
  }
  return (
    <div className={ring ? 'load-busy' : 'load-busy unseen'} role={role}>
      <span className="spinner" aria-hidden="true" />
      <span>{said}</span>
    </div>
  );
}

/* A load that failed, in the room of what it holds: why, then what to do, and Retry. words: what failed and what to do, where
   the screen knows better. slowHint: a connection of a plan that takes longer than usual, which says so with the ring still
   turning, as its sign-in still runs, and this hint; ring: false where the part already shows its ring. Stop is only where
   a load can be stopped. */
type FailProps = { load: Load; onRetry(): unknown; retryLabel?: string; words?: [string, string]; slowHint?: string; ring?: boolean; stop?: { text: string; label?: string; run(): unknown } };

const OPENS = '«"“„';
const CLOSES = '»"”“';

/* A failure's words with the name of the button they quote kept whole on one line, quotes and all, so «Повторить» never
   breaks into «По-» and «вторить». */
export function KeepName({ text, name }: { text: string; name: string }) {
  const at = text.indexOf(name);
  if (at < 0) return <>{text}</>;
  const end = at + name.length;
  const from = at > 0 && OPENS.includes(text[at - 1]!) ? at - 1 : at;
  const to = end < text.length && CLOSES.includes(text[end]!) ? end + 1 : end;
  return <>{text.slice(0, from)}<span className="lf-name">{text.slice(from, to)}</span>{text.slice(to)}</>;
}

export function LoadFail({ load, onRetry, retryLabel, words, slowHint, ring = true, stop }: FailProps) {
  const t = useT();
  const slow = slowHint !== undefined;
  const [what, next] = slow ? [t.common.tooLong, slowHint] : words ?? failWords(t, load.failure);
  return (
    <div className={slow ? 'load-fail slow' : 'load-fail'} role={slow ? 'status' : 'alert'}>
      {/* Each sentence in the direction of its own language, so its period stays at its end on a page laid out right to left. */}
      <p className="lf-t" dir="auto">{slow && ring && <span className="spinner" aria-hidden="true" />}<span><KeepName text={what} name={t.common.retry} /></span></p>
      <p className="lf-h" dir="auto"><KeepName text={next} name={t.common.retry} /></p>
      <div className="entry-actions">
        <button className="btn" type="button" aria-label={retryLabel} onClick={() => void onRetry()}>{t.common.retry}</button>
        {stop && <button className="btn ghost" type="button" aria-label={stop.label} onClick={() => void stop.run()}>{stop.text}</button>}
      </div>
    </div>
  );
}

/* Whether the content just came after a wait, so it fades in; content there from the start shows at once. */
function useArrived(phase: Load['phase']): boolean {
  const was = useRef(phase);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (phase === 'done' && was.current !== 'done') setArrived(true);
    was.current = phase;
  }, [phase]);
  return arrived && phase === 'done';
}

/* The held room of a part of a screen: what it holds is drawn at its final size, the skeleton while the data comes, then the
   data, which fades in. Failed, the block that says so takes the room's place, and the room keeps its size under it,
   unseen; a room that keeps what it holds (keep) shows the block in its own line instead, with LoadLine, and the rest stays
   (Design #1656). After Retry the focus stays in the room, never on the top of the page. */
type HoldProps = { load: Load; className?: string; words?: [string, string]; keep?: boolean; children?: ReactNode };

/* Retry from inside a room, which keeps the focus in it. */
const RoomRetry = createContext<(() => void) | null>(null);

const stalled = (load: Load) => load.phase === 'failed';
const roomClass = (className?: string) => (className ? `load-hold ${className}` : 'load-hold');
const holdsClass = (off: boolean, arrived: boolean) => (off ? 'load-gone' : arrived ? 'load-in arrive' : 'load-in');

export function Hold({ load, className, words, keep, children }: HoldProps) {
  const room = useRef<HTMLDivElement>(null);
  const arrived = useArrived(load.phase);
  const off = !keep && stalled(load);
  const retry = () => {
    load.retry();
    room.current?.focus({ preventScroll: true });
  };
  return (
    <div ref={room} className={roomClass(className)} tabIndex={-1} aria-busy={load.phase === 'loading'}>
      <RoomRetry.Provider value={retry}>
        <div className={holdsClass(off, arrived)} aria-hidden={off || undefined}>{children}</div>
      </RoomRetry.Provider>
      {off && <LoadFail load={load} onRetry={retry} words={words} />}
    </div>
  );
}

/* The line of a room that keeps what it holds where its ring stands: the ring and its words while the data comes, then once
   failed why, with Retry, in the same place, while the rest of the room stays. */
export function LoadLine({ load, words, live }: { load: Load; words?: ReactNode; live?: boolean }) {
  const retry = useContext(RoomRetry) ?? load.retry;
  if (stalled(load)) return <LoadFail load={load} onRetry={retry} />;
  return <Busy ring={load.ring} words={words} live={live} />;
}

/* Where a part of a screen's data will stand while it comes, with no skeleton of its own: the ring and its words, then why
   it stalled with Retry, then nothing once it all came. */
type StateProps = { load: Load; form?: 'inline' | 'screen'; words?: ReactNode; live?: boolean };

export function LoadState({ load, form, words, live }: StateProps) {
  if (load.phase === 'done') return null;
  return (
    <Hold load={load} className={form === 'screen' ? 'load-screen' : undefined}>
      <Busy ring={load.ring} words={words} form={form} live={live} />
    </Hold>
  );
}
