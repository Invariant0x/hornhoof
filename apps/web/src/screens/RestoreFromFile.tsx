import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, Phrase, useLanguage, useT } from '../i18n';
import type { RecoveryView } from '../types';
import { useConfirmAction } from '../ui/ConfirmAction';
import { Field } from '../ui/Field';
import { NOT_A_LOGIN } from '../ui/SecretInput';
import { RestoreProgress, sizeOf, textOf, when } from './Backups';

/* How often the server is asked what came in, and whether the company is back. */
const LOOK_MS = 5000;
/* A backup file starts with two lines of text, the second of which says what it is. */
const HEAD_BYTES = 70_000;

/* The id of a backup file, read from its head; null for a file that is no backup. */
async function bundleId(file: File): Promise<string | null> {
  try {
    const [, head = ''] = (await textOf(file.slice(0, HEAD_BYTES))).split('\n');
    const { id } = JSON.parse((JSON.parse(head) as { manifest: string }).manifest) as { id?: unknown };
    return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/* The setup screen of a server set up anew after the old one was lost: the person gives it the recovery file, waits
   for the company's backups to come in from the machines that are still on, or uploads one, and picks one to restore.
   code: the setup code the setup link brought, or none, and then it is asked for. recovering: the server has the file
   already, as after the page was opened again. */
export function RestoreFromFile({ code: linkCode, recovering = false, onBack }: { code: string; recovering?: boolean; onBack: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const [code, setCode] = useState(linkCode);
  const [view, setView] = useState<RecoveryView | null>(null);
  /* The server answered that it has no recovery file any more, while this page had given it one. */
  const [forgotten, setForgotten] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();
  const asked = encodeURIComponent(code);

  /* What came in so far. A server that knows of no recovery has its company back, which ends the waiting; or it started
     again with none, as after a restore that failed once the databases were touched, and is given the file again. */
  const look = useCallback(async () => {
    try {
      setView(await api.get<RecoveryView>(`/api/recovery?code=${asked}`));
    } catch (err) {
      if (!(err instanceof ApiFailure) || err.status !== 404) return;
      const { needed } = await api.get<{ needed: boolean }>('/api/setup');
      if (!needed) return setDone(true);
      setView(null);
      setForgotten(true);
    }
  }, [asked]);

  useEffect(() => {
    if (recovering && linkCode) void look().catch(() => undefined);
  }, [recovering, linkCode, look]);

  /* While the server restarts on the restored database a look fails, which is no news. */
  useEffect(() => {
    if (!view || done) return;
    const timer = setInterval(() => void look().catch(() => undefined), LOOK_MS);
    return () => clearInterval(timer);
  }, [view, done, look]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const give = (file: File) =>
    act(async () => {
      setView(await api.post<RecoveryView>('/api/recovery', { code, file: await textOf(file) }));
      setForgotten(false);
    });
  const upload = (file: File) =>
    act(async () => {
      const id = await bundleId(file);
      if (!id) throw new ApiFailure(400, 'validation', '', 'bundle_refused');
      await api.putFile(`/api/recovery/bundles/${id}?code=${asked}`, file);
      await look();
    });
  const restore = async (id: string) => {
    setBusy(true);
    try {
      await api.post('/api/recovery/restore', { code, id });
      await look();
    } finally {
      setBusy(false);
    }
  };
  const confirmRestore = (id: string, time: string) => {
    const words = t.backups.confirm.restore;
    setFailure(null);
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{time}</bdi>]} />,
      final: true,
      danger: true,
      onYes: () => restore(id),
    });
  };

  if (done) {
    return (
      <>
        <h1>{t.setup.restore.link}</h1>
        <p>{t.setup.restore.done}</p>
        <div className="actions"><a className="btn" href="/">{t.setup.restore.signIn}</a></div>
      </>
    );
  }
  const running = view?.restore?.state === 'running';
  return (
    <>
      <h1>{t.setup.restore.link}</h1>
      {!view && (
        <>
          <p className="muted">{t.setup.restore.choose}</p>
          {forgotten && <p className="update-note">{t.setup.restore.again}</p>}
          {!linkCode && (
            <Field label={t.setup.code} hint={t.setup.codeHint}>
              {p => <input {...p} {...NOT_A_LOGIN} value={code} onChange={e => setCode(e.target.value)} maxLength={200} autoComplete="off" spellCheck={false} />}
            </Field>
          )}
          <Field label={t.backups.recoveryFile}>
            {p => <input {...p} type="file" accept=".txt,text/plain" disabled={busy || !code.trim()} onChange={e => e.target.files?.[0] && void give(e.target.files[0])} />}
          </Field>
        </>
      )}
      {view && !running && (
        <>
          <p className="muted">{t.setup.restore.waiting}</p>
          {view.bundles.map(bundle => {
            const time = when(language, bundle.dumpedAt);
            return (
              <div key={bundle.id} className="settings-actions">
                <span className="entry-main">{time}, {sizeOf(t, bundle.size)}</span>
                <div className="entry-actions">
                  <button className="btn small" type="button" disabled={busy} aria-label={t.backups.restoreLabel(time)} onClick={() => confirmRestore(bundle.id, time)}>{t.setup.restore.thisOne}</button>
                </div>
              </div>
            );
          })}
          <Field label={t.setup.restore.upload}>
            {p => <input {...p} type="file" disabled={busy} onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />}
          </Field>
        </>
      )}
      {view?.restore && <RestoreProgress status={view.restore} />}
      {confirmation.question}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {!running && <div className="actions"><button className="btn ghost" type="button" onClick={onBack}>{t.setup.restore.newCompany}</button></div>}
    </>
  );
}
