import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { linkNameOf } from '@hornhoof/protocol/link';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Me } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { blocks, LinkName, type NameCheck, type NameState } from '../ui/LinkName';
import { useDialogClose } from '../ui/use-dialog-close';

type Link = { name: string; url: string };
type Loaded = { link: Link | null; domain: string };

/* The company's settings, for people who see the whole company: for now its public link at hornhoof.org, which they
   copy, move to another name or remove. */
export function Settings({ me, onClose, onHome }: { me: Me; onClose: () => void; onHome?: () => void }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [name, setName] = useState('');
  const [state, setState] = useState<NameState>('empty');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const box = useDialogClose(onClose);
  const suggested = linkNameOf(me.company.name);

  useEffect(() => {
    api
      .get<Loaded>('/api/link')
      .then(found => {
        setLoaded(found);
        if (!found.link) setName(suggested);
      })
      .catch(setFailure);
  }, [suggested]);

  async function run(change: () => Promise<Link | null>) {
    setBusy(true);
    setFailure(null);
    try {
      const link = await change();
      setLoaded(was => ({ domain: was?.domain ?? '', link }));
      setMode('view');
      if (!link) setName(suggested);
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
  if (unavailableFailure(failure)) return <RouteUnavailable dialog onHome={onHome} />;

  return (
    <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="settings-title">{t.settings.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
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
                    <button className="btn small ghost" type="button" onClick={() => setMode('remove')}>{t.settings.remove}</button>
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
                <LinkName name={name} onName={setName} domain={loaded.domain} check={check} onState={setState} current={link?.name} />
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
      </div>
    </div>
  );
}
