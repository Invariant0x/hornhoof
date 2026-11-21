import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorText, Phrase, useLanguage, useT } from '../i18n';
import type { UpdateCalledOff, UpdatesView, UpdateWaiting } from '../types';
import type { Updates } from '../updates';
import { useConfirmAction } from './ConfirmAction';
import { useBarFold } from './shellBars';
import { UpdateProgress } from './UpdateProgress';
import { buildText, versionText } from './VersionMark';
import { updateTargetText, versionedStatus } from './UpdateVersion';

const LATER = 'hh-later';
const SEEN = 'hh-update-seen';
const CALLED_OFF = 'hh-update-called-off';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private windows may refuse; the banner then comes back on the next visit. */
  }
}

type WaitNote = { waiting: UpdateWaiting } | { calledOff: UpdateCalledOff };

/* An update that waits for the agents, or one that was called off, until the person saw that. */
function waitNoteOf({ waiting, calledOff }: UpdatesView['updater']): WaitNote | null {
  if (waiting) return { waiting };
  return calledOff && stored(CALLED_OFF) !== calledOff.at ? { calledOff } : null;
}

/* Until when an update waits for the agents, with the way to call it off; or that it was called off, and why. */
function WaitNoteBody({ note, onCallOff, onSeen }: { note: WaitNote; onCallOff: () => void; onSeen: (at: string) => void }) {
  const t = useT();
  const { language } = useLanguage();
  const hour = (iso: string) => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  if ('waiting' in note) {
    return (
      <>
        <span dir="auto">{t.updates.waiting(versionText(note.waiting), hour(note.waiting.until))}</span>
        <button className="btn small ghost" type="button" onClick={onCallOff}>{t.updates.callOff}</button>
      </>
    );
  }
  const why = { deadline: t.updates.calledOff, cancelled: t.updates.cancelled, failed: t.updates.notPassed }[note.calledOff.reason];
  return (
    <>
      <span dir="auto">{why(versionText(note.calledOff), hour(note.calledOff.at))}</span>
      <button className="btn small ghost" type="button" onClick={() => onSeen(note.calledOff.at)}>{t.updates.ok}</button>
    </>
  );
}

/* Whether the banner shows an update on its way: asked for, or running, with the server in maintenance or restarting
   meanwhile. */
function showsUpdate(updates: Updates): boolean {
  return updates.view !== null && (updates.starting || updates.view.updater.status?.state === 'running');
}

type CutTrack = { asked: boolean; saw: boolean };

/* Tracks whether an update requested from this banner hit a running-turns cut and was then dismissed. */
function nextCutTrack(track: CutTrack, updates: Updates, showingProgress: boolean): { next: CutTrack; focus: boolean } {
  if (updates.cut) return { next: { asked: track.asked, saw: track.saw || track.asked }, focus: false };
  if (track.saw) return { next: { asked: false, saw: false }, focus: !updates.starting && !showingProgress };
  return { next: { asked: updates.asking && track.asked, saw: false }, focus: false };
}

/* When an update asked from this banner is held for running turns and then cancelled, return focus to its Update button. */
function useCutFocusReturn(updates: Updates, showingProgress: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const track = useRef<CutTrack>({ asked: false, saw: false });
  useEffect(() => {
    const { next, focus } = nextCutTrack(track.current, updates, showingProgress);
    track.current = next;
    if (focus) button.current?.focus();
  }, [updates.cut, updates.asking, updates.starting, showingProgress]);
  return { button, markAsked: () => { track.current.asked = true; } };
}

/* Under the top bar: a newer build to take, an update waiting for the agents or running, or how the last one ended. */
export function UpdateBanner({ updates, onDetails, onProgressShown }: {
  updates: Updates; onDetails: () => void; onProgressShown?: (shown: boolean) => void;
}) {
  const t = useT();
  const [, rerender] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();
  const fold = useBarFold();
  const showingProgress = showsUpdate(updates);
  const cutReturn = useCutFocusReturn(updates, showingProgress);
  useLayoutEffect(() => {
    if (!showingProgress || !onProgressShown) return;
    onProgressShown(true);
    return () => onProgressShown(false);
  }, [showingProgress, onProgressShown]);
  const { view } = updates;
  if (!view) return null;
  const { status } = view.updater;
  const note = waitNoteOf(view.updater);

  async function act(run: () => Promise<void>) {
    setFailure(null);
    try {
      await run();
    } catch (err) {
      setFailure(err);
    }
  }

  const hide = (key: string, value: string) => {
    store(key, value);
    rerender(n => n + 1);
  };

  const askUpdate = (build: string) => {
    const words = t.updates.confirm.update;
    setFailure(null);
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{build}</bdi>]} />,
      onYes: () => {
        cutReturn.markAsked();
        return updates.update('latest', false);
      },
    });
  };

  let body: React.ReactNode = null;
  if (showingProgress) {
    body = (
      <>
        <UpdateProgress version={updateTargetText(updates)} step={updates.starting ? null : status!.step} starting={updates.starting} offline={updates.offline} maintenance={updates.maintenance} />
        <button className="btn small ghost" type="button" onClick={onDetails}>{t.updates.details}</button>
      </>
    );
  } else if (note) {
    body = <WaitNoteBody note={note} onCallOff={() => void act(updates.callOff)} onSeen={at => hide(CALLED_OFF, at)} />;
  } else if (status && stored(SEEN) !== status.id) {
    body = (
      <>
        <span dir="auto">{t.updates.result(versionedStatus(status), versionText(view.current))}</span>
        {status.state !== 'done' && <button className="btn small ghost" type="button" onClick={onDetails}>{t.updates.details}</button>}
        <button className="btn small ghost" type="button" onClick={() => hide(SEEN, status.id)}>{t.updates.ok}</button>
      </>
    );
  } else if (view.available && view.latest && stored(LATER) !== view.latest.commit) {
    const latest = view.latest;
    const build = buildText(latest);
    body = (
      <>
        <span dir="auto">{t.updates.out(build, latest.title)}</span>
        <button ref={cutReturn.button} className="btn small" type="button" disabled={updates.asking} onClick={() => askUpdate(build)}>{t.updates.update}</button>
        <button className="btn small ghost" type="button" disabled={updates.asking} onClick={() => void act(() => updates.update('latest', true))}>{t.updates.whenIdle}</button>
        <button className="btn small ghost" type="button" onClick={() => hide(LATER, latest.commit)}>{t.updates.later}</button>
      </>
    );
  }
  if (!body) return null;
  return (
    <div className={fold.className} role="status" aria-label={t.updates.label}>
      {body}
      {fold.more}
      {confirmation.question}
      {failure !== null && <p className="update-error" role="alert" dir="auto">{errorText(t, failure)}</p>}
    </div>
  );
}
