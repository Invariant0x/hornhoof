import { MIN_SECRET_LENGTH } from '@hornhoof/protocol/redaction';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Phrase, useT } from '../i18n';
import { useConfirmAction } from './ConfirmAction';
import { Field } from './Field';
import { SecretInput } from './SecretInput';
import './hide-secret.css';

export function HideSecret({ taskId, taskLabel, onChanged, onClose, initialValue = '' }: { taskId: string; taskLabel?: string; onChanged: () => void; onClose?: () => void; initialValue?: string }) {
  const t = useT();
  const words = t.tasks.hideSecret;
  const confirm = t.tasks.confirm.hideSecret;
  const [open, setOpen] = useState(!!onClose);
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const confirmation = useConfirmAction();
  const close = () => { setOpen(false); setValue(''); onClose?.(); };
  const ready = !!value.trim() && [...value].length >= MIN_SECRET_LENGTH;

  async function hideNow(secret: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/hide-secret`, { value: secret });
      window.getSelection()?.removeAllRanges();
      close();
      onChanged();
    } catch (err) {
      setValue('');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    const secret = value;
    confirmation.ask({
      title: confirm.title,
      effect: taskLabel ? <Phrase words={confirm.effect} values={[<bdi>{taskLabel}</bdi>]} /> : confirm.effectGeneric,
      yes: confirm.yes,
      working: confirm.working,
      final: true,
      danger: true,
      onYes: () => hideNow(secret),
    });
  }

  if (!open) return <div className="secret-action entry-actions">
    <button type="button" className="btn ghost" onClick={() => { setValue(window.getSelection()?.toString() ?? ''); setOpen(true); }}>{words.action}</button>
  </div>;

  return <>
    <form className="secret-action" onSubmit={submit} aria-label={words.action}>
      <p className="muted"><bdi>{words.hint}</bdi></p>
      <Field label={words.value}>
        {props => <SecretInput {...props} value={value} disabled={busy} onChange={event => setValue(event.target.value)} />}
      </Field>
      <div className="entry-actions" role="group" aria-label={words.action}>
        <button type="submit" className="btn" disabled={busy || !ready}>{busy ? words.hiding : words.confirm}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={close}>{t.common.cancel}</button>
      </div>
    </form>
    {confirmation.question}
  </>;
}
