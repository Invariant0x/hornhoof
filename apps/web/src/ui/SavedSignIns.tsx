import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';

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

/* "Sign-in to www.artstation.com saved by Clara, 16/11/2026, 15:00": from the vault, by a person, or by one who left. */
function lineOf(s: Messages['agent'], x: SavedSignIn, at: string): string {
  const host = hostOf(x.site);
  if (x.source === 'vault') return s.signInFromVault(host, at);
  return x.savedBy?.name ? s.signInBy(host, x.savedBy.name, at) : s.signInSaved(host, at);
}

/* The list of the employee's saved sign-ins, read once the card opens. */
function useSignIns(path: string) {
  const [signIns, setSignIns] = useState<SavedSignIn[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
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
  return { signIns, setSignIns, failure, setFailure };
}

function SignInRow({ signIn, line, busy, onRevoke }: { signIn: SavedSignIn; line: string; busy: boolean; onRevoke(): void }) {
  const s = useT().agent;
  return (
    <li>
      <span className="entry-main">{line}</span>
      <div className="entry-actions">
        <button className="act danger" type="button" disabled={busy} aria-label={s.signInRevokeOf(hostOf(signIn.site))} onClick={onRevoke}>
          {s.signInRevoke}
        </button>
      </div>
    </li>
  );
}

export function SavedSignIns({ agentId }: { agentId: string }) {
  const t = useT();
  const s = t.agent;
  const { language } = useLanguage();
  const id = useId();
  const path = `/api/agents/${agentId}/sign-ins`;
  const { signIns, setSignIns, failure, setFailure } = useSignIns(path);
  const [busy, setBusy] = useState(false);
  const when = (iso: string) => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

  async function revoke(signIn: SavedSignIn) {
    setBusy(true);
    setFailure(null);
    try {
      await api.del(`${path}/${signIn.id}`);
      setSignIns(list => list && list.filter(x => x.id !== signIn.id));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const list = signIns ?? [];
  return (
    <section className="ac-sign-ins" aria-labelledby={`${id}-sign-ins`}>
      <h4 id={`${id}-sign-ins`}>{s.signIns}</h4>
      <p className="muted">{s.signInsAbout}</p>
      {signIns?.length === 0 && failure === null && <p className="muted">{s.signInsNone}</p>}
      {list.length > 0 && (
        <ul>
          {list.map(x => (
            <SignInRow key={x.id} signIn={x} line={lineOf(s, x, when(x.savedAt))} busy={busy} onRevoke={() => void revoke(x)} />
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
