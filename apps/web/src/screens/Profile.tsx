import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Me, PersonView } from '../types';
import { takeEscape } from '../ui/escape';
import { Field } from '../ui/Field';
import { Themes } from '../ui/Themes';

const SECTIONS = ['profile', 'themes'] as const;
export type SettingsSection = (typeof SECTIONS)[number];

type SectionProps = { section: SettingsSection; onSection?: (section: SettingsSection) => void };

/* The switch between the sections; the one open is the current page. */
function SettingsNav({ section, onSection }: SectionProps) {
  const t = useT();
  const label: Record<SettingsSection, string> = { profile: t.profile.profile, themes: t.skins.title };
  return (
    <nav className="seg settings-nav" aria-label={t.profile.sections}>
      {SECTIONS.map(id => (
        <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => onSection?.(id)}>
          {label[id]}
        </button>
      ))}
    </nav>
  );
}

/* The name a person goes by, saved for everyone in the company. */
function NameForm({ me, onRenamed }: { me: Me; onRenamed?: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState(me.person.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

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
  );
}

type ProfileProps = Partial<SectionProps> & { me: Me; onRenamed?: (name: string) => void; onClose: () => void };

/* A person's own settings, for everyone signed in: their name under Profile, and the look of Hornhoof in this browser
   under Themes. Each section has its own address, and the switch between them keeps what lies under the window. */
export function Profile({ me, section = 'profile', onSection, onRenamed, onClose }: ProfileProps) {
  const t = useT();
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

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog user-settings" role="dialog" aria-modal="true" aria-labelledby="profile-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="profile-title">{t.profile.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        <SettingsNav section={section} onSection={onSection} />
        {section === 'themes' ? <Themes /> : <NameForm me={me} onRenamed={onRenamed} />}
      </div>
    </div>
  );
}
