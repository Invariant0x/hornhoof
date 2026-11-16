import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';

/* The sign-ins saved for an employee: the sites whose pages its hh-browse opens as signed in, who saved each and when.
   One press revokes a sign-in. Nothing of a sign-in itself comes to this screen: the server answers with where, how and
   when only. */

export type SavedSignIn = { id: string; site: string; source: 'person' | 'vault'; savedBy: { id: string; name: string } | null; savedAt: string };

const hostOf = (site: string): string => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

export function SavedSignIns({ agentId }: { agentId: string }) {
  const t = useT();
  const s = t.agent;
  const { language } = useLanguage();
  const id = useId();
  const [signIns, setSignIns] = useState<SavedSignIn[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const path = `/api/agents/${agentId}/sign-ins`;
  const when = (iso: string) => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

  useEffect(() => {
    let live = true;
    api.get<{ signIns: SavedSignIn[] }>(path).then(
      got => live && setSignIns(got.signIns),
      err => live && (setFailure(err), setSignIns([])),
    );
    return () => {
      live = false;
    };
  }, [path]);

  async function revoke(signIn: SavedSignIn) {
    setBusy(signIn.id);
    setFailure(null);
    try {
      await api.del(`${path}/${signIn.id}`);
      setSignIns(list => list && list.filter(x => x.id !== signIn.id));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  }

  const said = (x: SavedSignIn) =>
    x.source === 'vault' ? s.signInFromVault(hostOf(x.site), when(x.savedAt)) : x.savedBy?.name ? s.signInBy(hostOf(x.site), x.savedBy.name, when(x.savedAt)) : s.signInSaved(hostOf(x.site), when(x.savedAt));

  return (
    <section className="ac-sign-ins" aria-labelledby={`${id}-sign-ins`}>
      <h4 id={`${id}-sign-ins`}>{s.signIns}</h4>
      <p className="muted">{s.signInsAbout}</p>
      {signIns && signIns.length === 0 && failure === null && <p className="muted">{s.signInsNone}</p>}
      {signIns && signIns.length > 0 && (
        <ul>
          {signIns.map(x => (
            <li key={x.id}>
              <span className="entry-main">{said(x)}</span>
              <div className="entry-actions">
                <button className="act danger" type="button" disabled={busy !== null} aria-label={s.signInRevokeOf(hostOf(x.site))} onClick={() => void revoke(x)}>
                  {s.signInRevoke}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </section>
  );
}
