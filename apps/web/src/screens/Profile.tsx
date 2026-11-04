import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Me, PersonView } from '../types';
import { takeEscape } from '../ui/escape';
import { Field } from '../ui/Field';

export function Profile({ me, onRenamed, onClose }: { me: Me; onRenamed?: (name: string) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(me.person.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setFailure(t.profile.nameRequired);
    setBusy(true);
    setFailure('');
    try {
      const res = await api.patch<{ person: PersonView }>(`/api/people/${me.person.id}`, { name: trimmed });
      setName(res.person.name);
      onRenamed?.(res.person.name);
    } catch (err) {
      setFailure(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="profile-title">{t.profile.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        <section className="settings-part">
          <form className="settings-form" noValidate onSubmit={e => void save(e)}>
            <Field label={t.common.name} problem={failure || undefined}>
              {p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}
            </Field>
            <div className="settings-actions">
              <button className="btn small" type="submit" disabled={busy}>{t.common.save}</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
