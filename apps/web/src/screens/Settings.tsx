import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, LANGUAGES, useLanguage, useT } from '../i18n';
import type { SettingsGroup } from '../routes';
import type { Me, PersonView, TlsView } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { takeEscape } from '../ui/escape';
import { Field } from '../ui/Field';
import { INTEGRATIONS, Integrations } from '../ui/Integrations';
import { LetsEncryptNote } from '../ui/LetsEncryptNote';
import { blocks, LinkName, type NameCheck, type NameState } from '../ui/LinkName';
import { useScrollbarRoom } from '../ui/scrollbar-room';
import { Themes } from '../ui/Themes';
import { Vault, VAULT_PATH } from '../ui/Vault';
import { Backups } from './Backups';
import { useSteady } from './Feedback';
import { unavailableFailure } from './RouteUnavailable';

/* The parts of the window in their order: Profile, then the four groups. Appearance & language has no group of its own in
   the address. */
type Group = 'appearance' | SettingsGroup;
const GROUPS: readonly Group[] = ['profile', 'appearance', 'integrations', 'passwords', 'company'];
/* What the window asks the server once it opens: a group shows only when the server gives this person what it holds. */
const PROBES: readonly string[] = [...INTEGRATIONS.map(tool => tool.probe), VAULT_PATH];

/* The addresses of PROBES the server answered, or null until every one did. */
function useReached(): ReadonlySet<string> | null {
  const [reached, setReached] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.allSettled(PROBES.map(path => api.get(path))).then(answers => {
      if (live) setReached(new Set(PROBES.filter((_, at) => answers[at]!.status === 'fulfilled')));
    });
    return () => {
      live = false;
    };
  }, []);
  return reached;
}

/* Company & access holds the public link for a person who sees the whole company and the backups for the CEO: anyone
   else would find it empty. */
const companyShown = (me: Me) => me.person.scopeKind === 'company' || me.person.isOwner;

/* Whether this person has a group: Profile and Appearance & language everyone, the others when the server gives them
   what the group holds. reached is null until the server said. */
function groupShown(group: Group, me: Me, reached: ReadonlySet<string> | null): boolean {
  if (group === 'company') return companyShown(me);
  if (group === 'integrations') return reached !== null && INTEGRATIONS.some(tool => reached.has(tool.probe));
  if (group === 'passwords') return reached !== null && reached.has(VAULT_PATH);
  return true;
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
    <section className="settings-part" aria-label={t.settings.groups.profile}>
      <form className="settings-form" noValidate onSubmit={e => void save(e)}>
        <Field label={t.common.name} problem={failure || undefined}>
          {p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} required />}
        </Field>
        <div className="settings-actions">
          <button className="btn small" type="submit" disabled={busy}>{t.common.save}</button>
        </div>
      </form>
    </section>
  );
}

/* The language Hornhoof speaks in this browser: one native list of every shipped language, each named in itself, that
   switches the page as soon as another is picked. Closed it keeps one line; a long name reads whole in the open list. */
function LanguagePart() {
  const t = useT();
  const id = useId();
  const { language, setLanguage } = useLanguage();
  return (
    <section className="settings-part lang-part" aria-labelledby={id}>
      <h4 id={id}>{t.language.title}</h4>
      <p id={`${id}-hint`} className="muted">{t.language.hint}</p>
      <div className="select-wrap">
        <select className="lang-select" aria-labelledby={id} aria-describedby={`${id}-hint`} value={language} onChange={e => setLanguage(LANGUAGES.find(choice => choice.id === e.target.value)?.id ?? language)}>
          {LANGUAGES.map(choice => (
            <option key={choice.id} value={choice.id} lang={choice.id}>{choice.name}</option>
          ))}
        </select>
      </div>
    </section>
  );
}

type Link = { name: string; url: string };
type Loaded = { link: Link | null; domain: string; tls?: TlsView | null };

/* Where the link's https ends, and whose agreement its certificate rests on. */
function Encryption({ tls }: { tls: TlsView | null }) {
  const t = useT();
  if (!tls) return null;
  return (
    <>
      <p className="update-note">{tls.mode === 'https' ? t.settings.encryptedHere : t.settings.encryptedRelay}</p>
      <LetsEncryptNote />
    </>
  );
}

/* The company's public link at hornhoof.org, which a person who sees the whole company copies, moves to another name or
   removes. A company with no link starts on a long random name, as link names are public. */
function CompanyLink() {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [name, setName] = useState('');
  const [state, setState] = useState<NameState>('empty');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    api.get<Loaded>('/api/link').then(setLoaded).catch(setFailure);
  }, []);

  async function run(change: () => Promise<Link | null>) {
    setBusy(true);
    setFailure(null);
    try {
      const link = await change();
      /* The old certificate is not shown after a change, since it was for the old name. */
      setLoaded(was => ({ domain: was?.domain ?? '', link, tls: null }));
      setMode('view');
      if (!link) setName('');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => (await api.put<{ link: Link }>('/api/link', { name })).link);
  const remove = () => run(async () => (await api.del('/api/link'), null));
  const check = (n: string) => api.get<NameCheck>(`/api/link/names/${encodeURIComponent(n)}`);
  const link = loaded?.link ?? null;
  if (unavailableFailure(failure)) return null;

  return (
    <>
      {loaded && (
        <section className="settings-part">
          <h3>{t.settings.link}</h3>
          {link && mode !== 'edit' ? (
            <>
              <p>{t.settings.opensAt}</p>
              <div className="settings-link">
                <a href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
                <CopyButton text={link.url} />
              </div>
              <Encryption tls={loaded.tls ?? null} />
              {mode === 'remove' ? (
                <div className="settings-actions">
                  <span className="entry-main">{t.settings.removeAsk(link.url)}</span>
                  <div className="entry-actions" role="group" aria-label={t.settings.removeAsk(link.url)}>
                    <button className="btn" type="button" disabled={busy} onClick={() => void remove()}>{t.settings.yesRemove}</button>
                    <button className="btn ghost" type="button" onClick={() => setMode('view')}>{t.settings.keep}</button>
                  </div>
                </div>
              ) : (
                <div className="settings-actions">
                  <button
                    className="btn small ghost"
                    type="button"
                    onClick={() => {
                      setName(link.name);
                      setFailure(null);
                      setMode('edit');
                    }}
                  >
                    {t.settings.change}
                  </button>
                  <button className="btn small ghost danger" type="button" onClick={() => setMode('remove')}>{t.settings.remove}</button>
                </div>
              )}
            </>
          ) : (
            <form
              className="settings-form"
              onSubmit={e => {
                e.preventDefault();
                void save();
              }}
            >
              {!link && <p>{t.settings.closed}</p>}
              <LinkName name={name} onName={setName} domain={loaded.domain} check={check} onState={setState} current={link?.name} startRandom={!link} />
              {link && <p className="update-note">{t.settings.moveNote}</p>}
              <div className="settings-actions">
                <button className="btn small" type="submit" disabled={busy || blocks(state)}>{link ? t.common.save : t.settings.open}</button>
                {link && <button className="btn small ghost" type="button" onClick={() => setMode('view')}>{t.common.cancel}</button>}
              </div>
            </form>
          )}
        </section>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </>
  );
}

/* Company & access: for a person who sees the whole company the public link, and for the CEO alone the backups. */
function CompanyGroup({ me }: { me: Me }) {
  return (
    <div className="settings-group">
      {me.person.scopeKind === 'company' && <CompanyLink />}
      {me.person.isOwner && <Backups />}
    </div>
  );
}

type GroupProps = { group: Group; me: Me; reached: ReadonlySet<string> | null; onRenamed?: (name: string) => void };

/* What the open group holds, once the server said which groups this person has; one it does not give them says so. */
function GroupContent({ group, me, reached, onRenamed }: GroupProps) {
  const t = useT();
  if (group === 'profile') return <div className="settings-group"><NameForm me={me} onRenamed={onRenamed} /></div>;
  if (group === 'appearance') return <div className="settings-group"><LanguagePart /><Themes /></div>;
  if (!reached && group !== 'company') return <p className="muted" role="status">{t.common.loading}</p>;
  if (!groupShown(group, me, reached)) {
    return (
      <section className="settings-part">
        <h4>{t.routes.accessDenied}</h4>
        <p className="muted">{t.routes.explanation}</p>
      </section>
    );
  }
  if (group === 'company') return <CompanyGroup me={me} />;
  if (group === 'passwords') return <Vault />;
  return <Integrations reached={reached!} />;
}

/* The open group under its heading, which takes the focus when the window opens, and what it holds in a line. */
function GroupBody(props: GroupProps) {
  const t = useT();
  const id = useId();
  const intro = props.group === 'appearance' || props.group === 'company' ? t.settings.intro[props.group] : props.group === 'integrations' ? t.integrations.intro : props.group === 'passwords' ? t.vault.intro : null;
  return (
    <section className="sgroup" data-group={props.group} aria-labelledby={id}>
      <header className="g-head">
        <h3 id={id} tabIndex={-1} data-autofocus>{t.settings.groups[props.group]}</h3>
        {intro && <p>{intro}</p>}
      </header>
      <GroupContent {...props} />
    </section>
  );
}

/* The switch between Profile and the groups, at the start of the window and above the group when it is narrow; the one
   open is the current page, and a line parts Profile from the groups. A group this person does not have is not there. */
function GroupNav({ group, me, reached, onGroup }: { group: Group; me: Me; reached: ReadonlySet<string> | null; onGroup: (group?: SettingsGroup) => void }) {
  const t = useT();
  return (
    <nav className="settings-nav" aria-label={t.settings.groupsLabel}>
      {GROUPS.filter(id => groupShown(id, me, reached)).map(id => (
        <Fragment key={id}>
          <button className="btn small ghost" type="button" aria-current={group === id ? 'page' : undefined} onClick={() => onGroup(id === 'appearance' ? undefined : id)}>
            {t.settings.groups[id]}
          </button>
          {id === 'profile' && <hr className="nav-sep" />}
        </Fragment>
      ))}
    </nav>
  );
}

type SettingsProps = {
  me: Me;
  group?: SettingsGroup;
  onGroup?: (group?: SettingsGroup) => void;
  onRenamed?: (name: string) => void;
  onClose: () => void;
};

const nothing = () => {};

/* Settings, for everyone signed in: Profile, then four groups, Appearance & language, Integrations, Passwords and Company &
   access. Each has its own address under /settings, and the switch between them keeps what lies under the window. */
export function Settings({ me, group, onGroup = nothing, onRenamed, onClose }: SettingsProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const close = useSteady(onClose);
  const reached = useReached();

  /* Only the body scrolls: it keeps the same 18 px for a scrollbar in every browser. */
  useScrollbarRoom(scroll);

  useEffect(() => {
    /* A person starts at the heading of the open group. */
    (box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  const current: Group = group ?? 'appearance';
  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="settings-title">{t.settings.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        <div className="settings-scroll" ref={scroll}>
          <div className="settings-body">
            <GroupNav group={current} me={me} reached={reached} onGroup={onGroup} />
            <div className="settings-main">
              <GroupBody group={current} me={me} reached={reached} onRenamed={onRenamed} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
