import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import type { NoteView } from '../types';

/* The company notebook in the orchestrator's window: what he keeps across conversations, which people who see the
   whole company read and change too. It is read again whenever it changes. */
export function Notebook() {
  const t = useT();
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ number: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ notes: NoteView[] }>('/api/notebook').catch(() => null);
    if (res) setNotes(res.notes);
  }, []);
  useEffect(() => void load(), [load]);
  useStream(m => {
    if (m.type === 'notebook' || m.type === 'reconnected') void load();
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
    void run(() => api.post('/api/notebook', { text: text.trim() }), () => setText(''));
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!editing?.text.trim()) return;
    void run(() => api.patch(`/api/notebook/${editing.number}`, { text: editing.text.trim() }), () => setEditing(null));
  }

  const who = (n: NoteView) => (n.by?.kind === 'orchestrator' ? t.window.orchestrator : n.by?.kind === 'person' ? n.by.name : '');

  return (
    <section className="notebook" aria-label={t.notebook.title}>
      <p className="muted">{t.notebook.intro}</p>
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
                  <button className="t-link" type="button" aria-label={t.notebook.changeNote(n.number)} onClick={() => setEditing({ number: n.number, text: n.text })}>
                    {t.notebook.change}
                  </button>
                  <button className="t-link" type="button" aria-label={t.notebook.removeNote(n.number)} disabled={busy} onClick={() => void run(() => api.del(`/api/notebook/${n.number}`), () => {})}>
                    {t.notebook.remove}
                  </button>
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
