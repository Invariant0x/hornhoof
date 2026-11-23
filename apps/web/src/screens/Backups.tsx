import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, Phrase, restoreEnded, useLanguage, useT, type Language, type Messages } from '../i18n';
import type { BackupBundle, BackupsView, RestoreStatus, RestoreStep, RestoreWarning } from '../types';
import { useConfirmAction } from '../ui/ConfirmAction';

/* A backup older than this is worth a look at the server's disk. */
const STALE_MS = 12 * 3_600_000;
/* How often a running restore is asked about. */
const LOOK_MS = 5000;
const STEPS: RestoreStep[] = ['fetch', 'check', 'open', 'load', 'swap', 'start'];
const MB = 1024 * 1024;

export const when = (language: Language, iso: string): string => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const sizeOf = (t: Messages, bytes: number): string => (bytes < MB ? t.tasks.fileKb(Math.max(1, Math.ceil(bytes / 1024))) : t.tasks.fileMb(Math.ceil(bytes / MB)));

/* A chosen file as text, read the way every browser has. */
export function textOf(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

/* The browser keeps the file: nothing of it stays on the page after that. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/* The recovery file: who saved it and when, and the button that saves a new one. */
function RecoveryFile({ view, onSaved, fail }: { view: BackupsView; onSaved: () => Promise<void>; fail: (err: unknown) => void }) {
  const t = useT();
  const { language } = useLanguage();
  const [busy, setBusy] = useState(false);
  /* When a file was saved from this page just now. */
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    fail(null);
    try {
      const file = await api.post<{ name: string; text: string }>('/api/backups/recovery');
      download(file.name, file.text);
      setSavedAt(new Date().toISOString());
      await onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const line = savedAt ? t.backups.savedNow(when(language, savedAt)) : view.recovery ? t.backups.savedBy(when(language, view.recovery.madeAt), view.recovery.madeBy) : t.backups.notSaved;
  return (
    <>
      <p className={savedAt || view.recovery ? undefined : 'update-note'}>{line}</p>
      <div className="settings-actions">
        <button className="btn small" type="button" disabled={busy} onClick={() => void save()}>{t.backups.save}</button>
      </div>
    </>
  );
}

/* What a restore undoes, for the CEO to read before it starts, with the choice whether what came after the backup
   comes back from the database the restore sets aside; and the recovery file to add when the server cannot open the
   backup by itself. The file's text is kept only while this question is open. */
function RestoreAsk({ bundle, warning, busy, onYes, onNo }: { bundle: BackupBundle; warning: RestoreWarning; busy: boolean; onYes: (bringBack: boolean, recoveryFile?: string) => void; onNo: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const fileId = useId();
  const bringId = useId();
  const [file, setFile] = useState<string | null>(null);
  const [bringBack, setBringBack] = useState(true);
  const needsFile = bundle.why === 'needs_recovery_file';
  const time = when(language, bundle.dumpedAt);
  const question = t.backups.ask(time);
  return (
    <div className="settings-part" role="group" aria-label={question}>
      <p><b>{question}</b></p>
      <p>
        <input id={bringId} type="checkbox" checked={bringBack} onChange={e => setBringBack(e.target.checked)} />{' '}
        <label htmlFor={bringId}>{t.backups.bringBack(time)}</label>
      </p>
      <p>{bringBack ? t.backups.bringBackOn(time) : t.backups.bringBackOff(time)}</p>
      {warning.machines.length > 0 && <p>{t.backups.machinesLater(warning.machines.map(machine => machine.name).join(', '))}</p>}
      {warning.people.length > 0 && <p>{t.backups.peopleLater(warning.people.join(', '))}</p>}
      <p>{t.backups.signInAgain}</p>
      <p>{t.backups.computerAccessAfterRestore}</p>
      {needsFile && (
        <p>
          <label htmlFor={fileId}>{t.backups.recoveryFile}</label>{' '}
          <input
            id={fileId}
            type="file"
            accept=".txt,text/plain"
            onChange={e => {
              const chosen = e.target.files?.[0];
              if (chosen) void textOf(chosen).then(setFile, () => setFile(null));
              else setFile(null);
            }}
          />
        </p>
      )}
      <div className="entry-actions">
        <button className="btn" type="button" disabled={busy || (needsFile && !file)} onClick={() => onYes(bringBack, needsFile ? (file ?? undefined) : undefined)}>{t.backups.restore}</button>
        <button className="btn ghost" type="button" onClick={onNo}>{t.common.cancel}</button>
      </div>
    </div>
  );
}

/* A restore as it goes: the steps it has reached, the one it is at, and how it ended. */
export function RestoreProgress({ status }: { status: RestoreStatus }) {
  const t = useT();
  if (status.state !== 'running') return <p className="update-note">{restoreEnded(t, status)}</p>;
  const at = STEPS.indexOf(status.step);
  return (
    <div className="settings-part" role="status">
      {STEPS.slice(0, at + 1).map((step, index) => <p key={step} className={index < at ? 'muted' : undefined} aria-current={index === at ? 'step' : undefined}>{t.backups.steps[step]}</p>)}
    </div>
  );
}

function Bundle({ bundle, restoring, onRestore }: { bundle: BackupBundle; restoring: boolean; onRestore: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const time = when(language, bundle.dumpedAt);
  const holders = bundle.where.map(place => {
    const name = place.machine === null ? t.backups.thisServer : place.name;
    return place.online ? name : t.backups.offline(name);
  });
  return (
    <div className="settings-actions">
      <span className="entry-main">
        <span>{time}, {t.backups.reasons[bundle.reason]}, {sizeOf(t, bundle.size)}</span>
        {holders.length > 0 && <><br /><span>{t.backups.heldBy(holders.join(', '))}</span></>}
        {bundle.recovery === 'older' && <><br /><span>{t.backups.olderFile}</span></>}
        {bundle.why && <><br /><span>{t.backups.why[bundle.why]}</span></>}
      </span>
      {bundle.restorable && !restoring && (
        <div className="entry-actions">
          <button className="btn small ghost" type="button" aria-label={t.backups.restoreLabel(time)} onClick={onRestore}>{t.backups.restore}</button>
        </div>
      )}
    </div>
  );
}

type Kept = BackupsView['kept'][number];

/* A database a restore set aside: that it is kept, how far the bringing back of what it holds has got, and the way to
   leave it out while that still waits or runs. */
function KeptDatabase({ kept, onLeave }: { kept: Kept; onLeave: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const time = when(language, kept.at);
  const merge = kept.merge ?? null;
  const waits = merge?.status === 'pending' || merge?.status === 'applied';
  const state = !merge ? null
    /* The server writes why in English: another language says that it did not go through yet. */
    : waits ? (merge.error ? (language === 'en' ? t.backups.keptStates.notYet(merge.error) : t.backups.keptStates.notYetPlain) : t.backups.keptStates.bringing)
      : merge.status === 'merged' ? t.backups.keptStates.merged(merge.added, merge.conflicts)
        : merge.status === 'removing' ? t.backups.keptStates.removing : null;
  return (
    <div className="settings-actions">
      <span className="entry-main">
        <span className="muted">{t.backups.kept(time)}</span>
        {state && <><br /><span>{state}</span></>}
      </span>
      {waits && (
        <div className="entry-actions">
          <button className="btn small ghost" type="button" aria-label={t.backups.leaveOutLabel(time)} onClick={onLeave}>{t.backups.leaveOut}</button>
        </div>
      )}
    </div>
  );
}

/* The company's backups, for the CEO alone: when the last one was made, the recovery file, the backups with the
   machines that hold each, and a restore from one. A restore asks first, saying what it undoes. */
export function Backups() {
  const t = useT();
  const { language } = useLanguage();
  const [view, setView] = useState<BackupsView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [asking, setAsking] = useState<{ bundle: BackupBundle; warning: RestoreWarning } | null>(null);
  const [busy, setBusy] = useState(false);
  const [absent, setAbsent] = useState(false);
  /* The session ended under a restore that ran: the restored company signs everyone out. */
  const [signedOut, setSignedOut] = useState(false);
  const confirmation = useConfirmAction();
  const running = view?.restore?.state === 'running';

  const load = useCallback(async () => {
    setView(await api.get<BackupsView>('/api/backups'));
  }, []);

  /* A server from before backups has no such route: then there is nothing to show, and nothing wrong. */
  useEffect(() => {
    load().catch((err: unknown) => (err instanceof ApiFailure && err.status === 404 ? setAbsent(true) : setFailure(err)));
  }, [load]);

  /* While a restore runs the server restarts on the restored database: a look that fails then is no news, but for the
     one that says the session is over, which is how a restore that went through ends for this page. */
  useEffect(() => {
    if (!running || signedOut) return;
    const timer = setInterval(() => void load().catch((err: unknown) => err instanceof ApiFailure && err.status === 401 && setSignedOut(true)), LOOK_MS);
    return () => clearInterval(timer);
  }, [running, signedOut, load]);

  async function ask(bundle: BackupBundle) {
    setFailure(null);
    try {
      setAsking({ bundle, warning: await api.get<RestoreWarning>(`/api/backups/${bundle.id}/warning`) });
    } catch (err) {
      setFailure(err);
    }
  }

  function confirmLeave(kept: Kept) {
    const words = t.backups.confirm.leaveOut;
    const time = when(language, kept.at);
    setFailure(null);
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{time}</bdi>]} />,
      warnings: [t.backups.leaveOutAsk],
      final: true,
      danger: true,
      onYes: async () => {
        await api.post(`/api/backups/kept/${kept.name}/leave`);
        await load();
      },
    });
  }

  async function restore(bundle: BackupBundle, bringBack: boolean, recoveryFile?: string) {
    setBusy(true);
    try {
      await api.post(`/api/backups/${bundle.id}/restore`, { ...(recoveryFile === undefined ? {} : { recoveryFile }), bringBack });
      setAsking(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function confirmRestore(bundle: BackupBundle, bringBack: boolean, recoveryFile?: string) {
    const words = t.backups.confirm.restore;
    const time = when(language, bundle.dumpedAt);
    setFailure(null);
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{time}</bdi>]} />,
      warnings: [bringBack ? t.backups.bringBackOn(time) : t.backups.bringBackOff(time), t.backups.signInAgain],
      final: true,
      danger: true,
      onYes: () => restore(bundle, bringBack, recoveryFile),
    });
  }

  if (absent) return null;
  if (signedOut) {
    return (
      <section className="settings-part">
        <h3>{t.backups.title}</h3>
        <p role="status">{t.backups.sessionEnded}</p>
        <div className="settings-actions"><a className="btn small" href="/">{t.setup.restore.signIn}</a></div>
      </section>
    );
  }
  return (
    <section className="settings-part">
      <h3>{t.backups.title}</h3>
      {view && (
        <>
          <p>{view.last ? t.backups.last(when(language, view.last)) : t.backups.none}</p>
          {view.last && Date.now() - Date.parse(view.last) > STALE_MS && <p className="update-note">{t.backups.stale}</p>}
          <RecoveryFile view={view} onSaved={load} fail={setFailure} />
          {view.restore && <RestoreProgress status={view.restore} />}
          {view.kept.map(kept => <KeptDatabase key={kept.name} kept={kept} onLeave={() => confirmLeave(kept)} />)}
          {view.bundles.length > 0 && <h3>{t.backups.restoreFrom}</h3>}
          {asking
            ? <RestoreAsk bundle={asking.bundle} warning={asking.warning} busy={busy} onYes={(bringBack, file) => confirmRestore(asking.bundle, bringBack, file)} onNo={() => setAsking(null)} />
            : view.bundles.map(bundle => <Bundle key={bundle.id} bundle={bundle} restoring={running} onRestore={() => void ask(bundle)} />)}
        </>
      )}
      {confirmation.question}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}
