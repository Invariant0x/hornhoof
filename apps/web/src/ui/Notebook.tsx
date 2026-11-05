import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import type { NoteView } from '../types';

/* A notebook in an agent's window: the company's in the orchestrator's, which people who see the whole company read and
   change too, or a department's in its head's, for people who run that department. It is read again whenever it changes. */
export function Notebook({ departmentId = null }: { departmentId?: string | null }) {
  const t = useT();
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ number: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  /* Why the notes could not be read, until they are read again. */
  const [unread, setUnread] = useState<unknown>(null);

  const base = departmentId ? `/api/departments/${departmentId}/notebook` : '/api/notebook';
  const load = useCallback(async () => {
    try {
      setNotes((await api.get<{ notes: NoteView[] }>(base)).notes);
      setUnread(null);
    } catch (err) {
      setUnread(err);
    }
  }, [base]);
  useEffect(() => void load(), [load]);
  useStream(m => {
    if ((m.type === 'notebook' && m.spot.departmentId === departmentId) || m.type === 'reconnected') void load();
  });

  async function run(action: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      after();
      await load();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    void run(() => api.post(base, { text: text.trim() }), () => setText(''));
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!editing?.text.trim()) return;
    void run(() => api.patch(`${base}/${editing.number}`, { text: editing.text.trim() }), () => setEditing(null));
  }

  const who = (n: NoteView) => (n.by?.kind === 'orchestrator' ? t.window.orchestrator : n.by ? n.by.name : '');

  return (
    <section className="notebook" aria-label={t.notebook.title}>
      <p className="muted">{departmentId ? t.notebook.departmentIntro : t.notebook.intro}</p>
      {unread !== null && (
        <div className="notebook-unread">
          <p className="error" role="alert">
            {t.notebook.unread} {errorText(t, unread)}
          </p>
          <button className="btn small ghost" type="button" onClick={() => void load()}>
            {t.app.tryAgain}
          </button>
        </div>
      )}
      {notes && !notes.length && <p className="muted">{t.notebook.empty}</p>}
      {notes && notes.length > 0 && (
        <ul aria-label={t.notebook.title}>
          {notes.map(n => (
            <li key={n.number}>
              <b>#{n.number}</b>
              {editing?.number === n.number ? (
                <form onSubmit={save}>
                  <textarea aria-label={t.notebook.note(n.number)} value={editing.text} maxLength={300} rows={2} onChange={e => setEditing({ number: n.number, text: e.target.value })} />
                  <button className="btn small" type="submit" disabled={busy}>
                    {t.notebook.save}
                  </button>
                  <button className="btn small ghost" type="button" onClick={() => setEditing(null)}>
                    {t.notebook.cancel}
                  </button>
                </form>
              ) : (
                <>
                  <span>{n.text}</span>
                  <small>{who(n)}</small>
                  <div className="notebook-item-actions">
                    <button className="t-link" type="button" aria-label={t.notebook.changeNote(n.number)} onClick={() => setEditing({ number: n.number, text: n.text })}>
                      {t.notebook.change}
                    </button>
                    <button className="t-link" type="button" aria-label={t.notebook.removeNote(n.number)} disabled={busy} onClick={() => void run(() => api.del(`${base}/${n.number}`), () => {})}>
                      {t.notebook.remove}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="notebook-add" onSubmit={add}>
        <textarea aria-label={t.notebook.newNote} placeholder={t.notebook.placeholder} value={text} maxLength={300} rows={2} onChange={e => setText(e.target.value)} />
        <button className="btn small" type="submit" disabled={busy || !text.trim()}>
          {t.notebook.add}
        </button>
      </form>
      {failure !== null && (
        <p className="error" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </section>
  );
}
