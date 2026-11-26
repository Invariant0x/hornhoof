import { useState } from 'react';
import { errorText, useLanguage, useT } from '../i18n';
import type { UpdateCalledOff, UpdatesView, UpdateWaiting } from '../types';
import type { Updates } from '../updates';
import { useBarFold } from './shellBars';
import { buildText, versionText } from './VersionMark';
import { updateIsRunning, versionedStatus } from './UpdateVersion';

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

/* Under the top bar: a newer build to take, an update waiting for the agents, or how the last one ended. An update on its way
   is no bar of its own: the service road says it, with its progress. */
export function UpdateBanner({ updates, onDetails }: { updates: Updates; onDetails: () => void }) {
  const t = useT();
  const [, rerender] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const fold = useBarFold();
  const { view } = updates;
  if (!view || updateIsRunning(updates)) return null;
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

  let body: React.ReactNode = null;
  if (note) {
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
    body = (
      <>
        <span dir="auto">{t.updates.out(buildText(latest), latest.title)}</span>
        <button className="btn small" type="button" disabled={updates.asking} onClick={() => void act(() => updates.update('latest', false))}>{t.updates.update}</button>
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
      {failure !== null && <p className="update-error" role="alert" dir="auto">{errorText(t, failure)}</p>}
    </div>
  );
}
