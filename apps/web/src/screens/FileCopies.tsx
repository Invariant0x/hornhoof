import { useEffect, useId, useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT, type Messages } from '../i18n';

/* How the company's file store stands, as the server says it: the copies the CEO asked for and those kept now, the
   machines that keep files, what the files take and what the machines' areas hold of them, the files kept fewer times
   than asked, and what waits on a machine that is to give it up. */
export type FileStoreView = {
  copies: number;
  effectiveCopies: number;
  machines: number;
  filesBytes: number;
  usedBytes: number;
  capacityBytes: number;
  underCopied: number;
  stuckBytes: number;
};

const COPIES = [1, 2, 3, 4, 5];
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const amount = (t: Messages, bytes: number): string => (bytes >= GB ? t.fileCopies.gb((bytes / GB).toFixed(1)) : t.tasks.fileMb(Math.max(1, Math.ceil(bytes / MB))));

/* How many machines keep each file of the company, for the CEO alone, with how the files stand under it. */
export function FileCopies() {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<FileStoreView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [absent, setAbsent] = useState(false);
  const [busy, setBusy] = useState(false);

  /* A server from before the store has no such route: then there is nothing to show, and nothing wrong. */
  useEffect(() => {
    api.get<FileStoreView>('/api/company/file-store').then(setView, (err: unknown) => (err instanceof ApiFailure && err.status === 404 ? setAbsent(true) : setFailure(err)));
  }, []);

  async function choose(copies: number) {
    setBusy(true);
    setFailure(null);
    try {
      setView(await api.patch<FileStoreView>('/api/company/file-store', { copies }));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (absent) return null;
  return (
    <section className="settings-part" aria-labelledby={id}>
      <h3 id={id}>{t.fileCopies.title}</h3>
      <p id={`${id}-hint`} className="muted">{t.fileCopies.hint}</p>
      {view && (
        <>
          <div className="select-wrap">
            <select className="lang-select" aria-labelledby={id} aria-describedby={`${id}-hint`} value={view.copies} disabled={busy} onChange={e => void choose(Number(e.target.value))}>
              {COPIES.map(n => <option key={n} value={n}>{t.fileCopies.copies(n)}</option>)}
            </select>
          </div>
          {view.machines === 0
            ? <p className="update-note">{t.fileCopies.noMachine}</p>
            : <p>{t.fileCopies.kept(view.effectiveCopies, view.machines)}</p>}
          {view.machines === 1 && <p className="update-note">{t.fileCopies.oneMachine}</p>}
          <p>{t.fileCopies.room(amount(t, view.filesBytes), amount(t, view.capacityBytes))}</p>
          {view.underCopied > 0 && <p className="update-note">{t.fileCopies.under(view.underCopied)}</p>}
          {view.stuckBytes > 0 && <p className="update-note">{t.fileCopies.stuck(amount(t, view.stuckBytes))}</p>}
        </>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}
