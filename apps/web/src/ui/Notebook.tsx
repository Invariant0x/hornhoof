import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import type { NoteView } from '../types';

type Editing = { number: number; text: string };

const notebookBase = (departmentId: string | null) => (departmentId ? `/api/departments/${departmentId}/notebook` : '/api/notebook');
const notebookChanged = (message: { type: string; spot?: { departmentId: string | null } }, departmentId: string | null) =>
  (message.type === 'notebook' && message.spot?.departmentId === departmentId) || message.type === 'reconnected';

function NotebookFeedback({ loading, unread, saving, failure, onRetry }: { loading: boolean; unread: unknown; saving: boolean; failure: unknown; onRetry(): void }) {
  const t = useT();
  return (
    <>
      {loading && <p className="muted">{t.common.loading}</p>}
      {unread !== null && (
        <div className="notebook-unread">
          <p className="error" role="alert">{t.notebook.unread} {errorText(t, unread)}</p>
          <button className="btn small ghost" type="button" onClick={onRetry}>{t.app.tryAgain}</button>
        </div>
      )}
      {saving && <p className="muted" role="status">{t.notebook.saving}</p>}
      {failure !== null && <p className="error" role="alert">{errorText(t, failure)}</p>}
    </>
  );
}

function NotebookItems({ notes, editing, busy, onEdit, onSave, onCancel, onRemove }: { notes: NoteView[] | null; editing: Editing | null; busy: boolean; onEdit(note: NoteView): void; onSave(event: FormEvent): void; onCancel(): void; onRemove(note: NoteView): void }) {
  const t = useT();
  if (!notes) return null;
  if (!notes.length) return <p className="muted">{t.notebook.empty}</p>;
  const who = (n: NoteView) => (n.by?.kind === 'orchestrator' ? t.window.orchestrator : n.by ? n.by.name : '');
  return (
    <ul aria-label={t.notebook.title}>
      {notes.map(n => (
        <li key={n.number}>
          <b>#{n.number}</b>
          {editing?.number === n.number ? (
            <form onSubmit={onSave}>
              <textarea aria-label={t.notebook.note(n.number)} value={editing.text} maxLength={300} rows={2} onChange={e => onEdit({ ...n, text: e.target.value })} />
              <button className="btn small" type="submit" disabled={busy}>{t.notebook.save}</button>
              <button className="btn small ghost" type="button" onClick={onCancel}>{t.notebook.cancel}</button>
            </form>
          ) : (
            <>
              <span>{n.text}</span>
              <small>{who(n)}</small>
              <div className="notebook-item-actions">
                <button className="t-link" type="button" aria-label={t.notebook.changeNote(n.number)} onClick={() => onEdit(n)}>{t.notebook.change}</button>
                <button className="t-link" type="button" aria-label={t.notebook.removeNote(n.number)} disabled={busy} onClick={() => onRemove(n)}>{t.notebook.remove}</button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

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

  const base = notebookBase(departmentId);
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
    if (notebookChanged(m, departmentId)) void load();
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

  const loading = notes === null && unread === null;

  return (
    <section className="notebook" aria-label={t.notebook.title} aria-busy={busy || loading}>
      <p className="muted">{departmentId ? t.notebook.departmentIntro : t.notebook.intro}</p>
      <NotebookFeedback loading={loading} unread={unread} saving={busy} failure={failure} onRetry={() => void load()} />
      <NotebookItems notes={notes} editing={editing} busy={busy} onEdit={n => setEditing({ number: n.number, text: n.text })} onSave={save} onCancel={() => setEditing(null)} onRemove={n => void run(() => api.del(`${base}/${n.number}`), () => {})} />
      <form className="notebook-add" onSubmit={add}>
        <textarea aria-label={t.notebook.newNote} placeholder={t.notebook.placeholder} value={text} maxLength={300} rows={2} onChange={e => setText(e.target.value)} />
        <button className="btn small" type="submit" disabled={busy || !text.trim()}>
          {t.notebook.add}
        </button>
      </form>
    </section>
  );
}
