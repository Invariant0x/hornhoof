import { useState } from 'react';
import { errorText, useT } from '../i18n';
import type { Updates } from '../updates';
import { UpdateProgress } from './UpdateProgress';

const LATER = 'hh-later';
const SEEN = 'hh-update-seen';

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

/* Under the top bar: a newer build to take, an update waiting for the agents or running, or how the last one ended. */
export function UpdateBanner({ updates, onDetails }: { updates: Updates; onDetails: () => void }) {
  const t = useT();
  const [, rerender] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const { view } = updates;
  if (!view) return null;
  const { status, waiting } = view.updater;

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
  if (updates.starting || status?.state === 'running') {
    const version = updates.starting ? (view.latest?.version ?? '') : status!.version;
    body = (
      <>
        <UpdateProgress version={version} step={updates.starting ? null : status!.step} starting={updates.starting} offline={updates.offline} />
        <button className="btn small ghost" type="button" onClick={onDetails}>{t.updates.details}</button>
      </>
    );
  } else if (waiting) {
    body = (
      <>
        <span>{t.updates.waiting(waiting.version)}</span>
        <button className="btn small ghost" type="button" onClick={() => act(updates.callOff)}>{t.updates.callOff}</button>
      </>
    );
  } else if (status && stored(SEEN) !== status.id) {
    body = (
      <>
        <span>{t.updates.result(status, view.current.version)}</span>
        {status.state !== 'done' && <button className="btn small ghost" type="button" onClick={onDetails}>{t.updates.details}</button>}
        <button className="btn small ghost" type="button" onClick={() => hide(SEEN, status.id)}>{t.updates.ok}</button>
      </>
    );
  } else if (view.available && view.latest && stored(LATER) !== view.latest.commit) {
    const latest = view.latest;
    body = (
      <>
        <span>{t.updates.out(latest.version || latest.tag, latest.title)}</span>
        <button className="btn small" type="button" onClick={() => act(() => updates.update('latest', false))}>{t.updates.update}</button>
        <button className="btn small ghost" type="button" onClick={() => act(() => updates.update('latest', true))}>{t.updates.whenIdle}</button>
        <button className="btn small ghost" type="button" onClick={() => hide(LATER, latest.commit)}>{t.updates.later}</button>
      </>
    );
  }
  if (!body) return null;
  return (
    <div className="update-banner glass" role="status" aria-label={t.updates.label}>
      {body}
      {failure !== null && <p className="update-error" role="alert">{errorText(t, failure)}</p>}
    </div>
  );
}
