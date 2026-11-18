import { MIN_SECRET_LENGTH } from '@hornhoof/protocol/redaction';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Field } from './Field';
import { SecretInput } from './SecretInput';
import './hide-secret.css';

export function HideSecret({ taskId, onChanged, onClose, initialValue = '' }: { taskId: string; onChanged: () => void; onClose?: () => void; initialValue?: string }) {
  const t = useT();
  const words = t.tasks.hideSecret;
  const [open, setOpen] = useState(!!onClose);
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => { setOpen(false); setValue(''); setFailed(false); onClose?.(); };
  const ready = !!value.trim() && [...value].length >= MIN_SECRET_LENGTH;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.post(`/api/tasks/${taskId}/hide-secret`, { value });
      window.getSelection()?.removeAllRanges();
      close();
      onChanged();
    } catch {
      setValue('');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <div className="secret-action entry-actions">
    <button type="button" className="btn ghost" onClick={() => { setValue(window.getSelection()?.toString() ?? ''); setOpen(true); }}>{words.action}</button>
  </div>;

  return <form className="secret-action" onSubmit={event => void submit(event)} aria-label={words.action}>
    <p className="muted"><bdi>{words.hint}</bdi></p>
    <Field label={words.value}>
      {props => <SecretInput {...props} value={value} disabled={busy} onChange={event => setValue(event.target.value)} />}
    </Field>
    {failed && <p className="bad" role="alert">{words.failed}</p>}
    <div className="entry-actions" role="group" aria-label={words.action}>
      <button type="submit" className="btn" disabled={busy || !ready}>{busy ? words.hiding : words.confirm}</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={close}>{t.common.cancel}</button>
    </div>
  </form>;
}
