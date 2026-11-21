import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { useState } from 'react';
import { errorText, useLanguage, useT } from '../i18n';
import type { Build, UpdatesView } from '../types';
import type { Updates } from '../updates';
import { NodeWaits } from '../ui/MachineDrain';
import { UpdateProgress } from '../ui/UpdateProgress';
import { buildText, versionText } from '../ui/VersionMark';
import { silentTime, updateTargetText, versionedStatus } from '../ui/UpdateVersion';
import { useDialogClose } from '../ui/use-dialog-close';

/* Explains when the updater stopped answering (auto-clearing) or is not running on this server. */
function UpdaterNotice({ updater }: { updater: UpdatesView['updater'] }) {
  const t = useT();
  const { language } = useLanguage();
  if (updater.silent) return <p className="update-note" role="status">{t.updates.silent(silentTime(language, updater.silent.since))}</p>;
  if (!updater.present) return <p className="update-note">{t.updates.missing}</p>;
  return null;
}

/* The builds Hornhoof can run, the one it runs, and the update under way or the last one's end. */
export function Versions({ updates, onClose, onHome }: { updates: Updates; onClose: () => void; onHome?: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const { view, busy } = updates;
  const [confirm, setConfirm] = useState<Build | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const box = useDialogClose(onClose);

  async function act(run: () => Promise<void>) {
    setFailure(null);
    try {
      await run();
    } catch (err) {
      setFailure(err);
    }
  }

  async function install(build: Build) {
    setConfirm(null);
    await act(() => updates.update(build === view?.latest ? 'latest' : build.tag, false));
  }

  if (unavailableFailure(updates.failure)) return <RouteUnavailable dialog onHome={onHome} />;
  if (!view) return null;
  const { current, latest, versions, updater } = view;
  const status = updater.status;
  const rows = latest && !versions.some(v => v.commit === latest.commit) ? [latest, ...versions] : versions;

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="versions-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="versions-title">{t.updates.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        <p>{t.updates.current(versionText(current))}</p>
        <div className="versions-check">
          <button
            className="btn small ghost"
            type="button"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void act(updates.check).finally(() => setChecking(false));
            }}
          >
            {t.updates.checkNow}
          </button>
          <span className="muted">{view.error ? t.updates.checkFailed : view.checkedAt && t.updates.checkedAt(new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(view.checkedAt)))}</span>
        </div>
        <UpdaterNotice updater={updater} />
        {updates.starting && !status && <UpdateProgress version={updateTargetText(updates)} step={null} starting offline={updates.offline} maintenance={updates.maintenance} />}
        {status && (
          <div className="update-progress">
            {updates.starting || status.state === 'running' ? (
              <UpdateProgress version={updateTargetText(updates)} step={updates.starting ? null : status.step} starting={updates.starting} offline={updates.offline} maintenance={updates.maintenance} />
            ) : (
              <p>{t.updates.result(versionedStatus(status), versionText(current))}</p>
            )}
            {status.log && <pre>{status.log}</pre>}
          </div>
        )}
        <NodeWaits waits={view.nodeWaits} />
        {failure !== null && <p className="update-error" role="alert">{errorText(t, failure)}</p>}
        <ul className="versions">
          {rows.map(b => (
            <li key={b.tag}>
              <div>
                <b>{buildText(b)}</b>
                {b.tag === 'latest' && <span className="muted">{t.updates.newest}</span>}
                {b.title && <span>{b.title}</span>}
                <span className="muted">{b.created.slice(0, 10)}</span>
              </div>
              {b.commit === current.commit ? (
                <span className="versions-now">{t.updates.runningNow}</span>
              ) : (
                updater.present &&
                !busy &&
                !updates.asking && (
                  <button className="act" type="button" onClick={() => (b.migrations < current.migrations ? setConfirm(b) : void install(b))}>
                    {t.updates.install}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
        {confirm && (
          <div className="update-confirm">
            <p>{t.updates.pastMigration}</p>
            <div className="actions">
              <button className="btn small" type="button" onClick={() => void install(confirm)}>{t.updates.goBack(buildText(confirm))}</button>
              <button className="btn small ghost" type="button" onClick={() => setConfirm(null)}>{t.common.cancel}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
