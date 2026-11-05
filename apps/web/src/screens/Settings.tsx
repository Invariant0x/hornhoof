import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Me, TlsView } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { LetsEncryptNote } from '../ui/LetsEncryptNote';
import { blocks, LinkName, type NameCheck, type NameState } from '../ui/LinkName';
import { takeEscape } from '../ui/escape';

type Link = { name: string; url: string };
type Loaded = { link: Link | null; domain: string; tls?: TlsView | null };
type Mode = 'view' | 'edit' | 'remove';

const checkName = (name: string) => api.get<NameCheck>(`/api/link/names/${encodeURIComponent(name)}`);

/* The link as the server has it, and the changes to it. A change tells whether it worked; a failure stays for the dialog
   to show. After a change the old certificate is not shown, since it was for the old name. */
function useLinkSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    api.get<Loaded>('/api/link').then(setLoaded).catch(setFailure);
  }, []);

  async function run(change: () => Promise<Link | null>): Promise<boolean> {
    setBusy(true);
    setFailure(null);
    try {
      const link = await change();
      setLoaded(was => ({ domain: was?.domain ?? '', link, tls: null }));
      return true;
    } catch (err) {
      setFailure(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    loaded,
    busy,
    failure,
    clearFailure: () => setFailure(null),
    save: (name: string) => run(async () => (await api.put<{ link: Link }>('/api/link', { name })).link),
    remove: () => run(async () => (await api.del('/api/link'), null)),
  };
}

type LinkSettings = ReturnType<typeof useLinkSettings>;

function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

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

interface ShownProps {
  link: Link;
  tls: TlsView | null;
  mode: Mode;
  busy: boolean;
  onMode: (mode: Mode) => void;
  onRemove: () => void;
}

/* The link the company has: copy it, change its name or remove it after asking. */
function LinkShown({ link, tls, mode, busy, onMode, onRemove }: ShownProps) {
  const t = useT();
  return (
    <>
      <p>{t.settings.opensAt}</p>
      <div className="settings-link">
        <a href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
        <CopyButton text={link.url} />
      </div>
      <Encryption tls={tls} />
      {mode === 'remove' ? (
        <div className="settings-actions">
          <span>{t.settings.removeAsk(link.url)}</span>
          <button className="btn small" type="button" disabled={busy} onClick={onRemove}>{t.settings.yesRemove}</button>
          <button className="btn small ghost" type="button" onClick={() => onMode('view')}>{t.settings.keep}</button>
        </div>
      ) : (
        <div className="settings-actions">
          <button className="btn small ghost" type="button" onClick={() => onMode('edit')}>{t.settings.change}</button>
          <button className="btn small ghost" type="button" onClick={() => onMode('remove')}>{t.settings.remove}</button>
        </div>
      )}
    </>
  );
}

interface EditorProps {
  link: Link | null;
  domain: string;
  busy: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}

/* Moving a link can be given up; opening a first one cannot. */
function CancelButton({ shown, onCancel }: { shown: boolean; onCancel: () => void }) {
  const t = useT();
  return shown ? <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button> : null;
}

/* The name of the link, to move it or to open one: a company with no link starts on a long random name. */
function LinkEditor({ link, domain, busy, onSave, onCancel }: EditorProps) {
  const t = useT();
  const [name, setName] = useState(link?.name ?? '');
  const [state, setState] = useState<NameState>('empty');
  return (
    <form
      className="settings-form"
      onSubmit={e => {
        e.preventDefault();
        onSave(name);
      }}
    >
      {!link && <p>{t.settings.closed}</p>}
      <LinkName name={name} onName={setName} domain={domain} check={checkName} onState={setState} current={link?.name} startRandom={!link} />
      {link && <p className="update-note">{t.settings.moveNote}</p>}
      <div className="settings-actions">
        <button className="btn small" type="submit" disabled={busy || blocks(state)}>{link ? t.common.save : t.settings.open}</button>
        <CancelButton shown={link !== null} onCancel={onCancel} />
      </div>
    </form>
  );
}

/* The link part of the dialog: the link as it is, or the form that names it. */
function LinkSection({ loaded, settings }: { loaded: Loaded; settings: LinkSettings }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('view');
  const { link, domain, tls } = loaded;
  const finish = async (worked: Promise<boolean>) => {
    if (await worked) setMode('view');
  };
  const choose = (next: Mode) => {
    settings.clearFailure();
    setMode(next);
  };
  return (
    <section className="settings-part">
      <h3>{t.settings.link}</h3>
      {link && mode !== 'edit' ? (
        <LinkShown link={link} tls={tls ?? null} mode={mode} busy={settings.busy} onMode={choose} onRemove={() => void finish(settings.remove())} />
      ) : (
        <LinkEditor link={link} domain={domain} busy={settings.busy} onSave={name => void finish(settings.save(name))} onCancel={() => choose('view')} />
      )}
    </section>
  );
}

/* The company's settings, for people who see the whole company: for now its public link at hornhoof.org, which they
   copy, move to another name or remove. */
export function Settings({ onClose }: { me: Me; onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const settings = useLinkSettings();
  useCloseOnEscape(onClose);
  useEffect(() => box.current?.focus(), []);

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="settings-title">{t.settings.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        {settings.loaded && <LinkSection loaded={settings.loaded} settings={settings} />}
        {settings.failure !== null && <p className="alert" role="alert">{errorText(t, settings.failure)}</p>}
      </div>
    </div>
  );
}
