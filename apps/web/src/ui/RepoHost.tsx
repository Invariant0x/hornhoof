import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, Phrase, useT } from '../i18n';
import type { RepoHost, RepoKey } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { Field } from './Field';
import { Idents } from './Idents';
import { IntegrationCard } from './IntegrationCard';
import { NOT_A_LOGIN, SecretInput } from './SecretInput';

type Props = {
  /* Where this key is saved. */
  path: string;
  /* The key saved there; never the key itself. */
  saved: RepoKey | null;
  /* What the person reads of the key in use. */
  says: ReactNode;
  /* The button that saves a first key there, and its classes: the record's main button where nothing is connected yet. */
  first: string;
  firstClass: string;
  /* The key there now, for whoever keeps it; a department's comes back with the company's view instead. */
  onSaved?: (key: RepoKey | null) => void;
};

/* One GitHub key, saved, changed or removed in place. An empty key field keeps the saved key. */
function KeyPart({ path, saved, says, first, firstClass, onSaved }: Props) {
  const t = useT();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [owner, setOwner] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();

  async function apply(change: () => Promise<RepoKey | null>) {
    const key = await change();
    onSaved?.(key);
    setMode('view');
    setToken('');
  }

  async function run(change: () => Promise<RepoKey | null>) {
    setBusy(true);
    setFailure(null);
    try {
      await apply(change);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function edit() {
    setOwner(saved?.owner ?? '');
    setToken('');
    setFailure(null);
    setMode('edit');
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const trimmedOwner = owner.trim();
    const body = { owner: trimmedOwner, ...(token.trim() ? { token: token.trim() } : {}) };
    const putKey = async () => (await api.put<{ host: RepoKey }>(path, body)).host;
    if (!saved) return void run(putKey);
    setFailure(null);
    confirmation.ask({
      ...t.repoHost.confirm.replace,
      effect: <Phrase words={t.repoHost.confirm.replace.effect} values={[<bdi>{trimmedOwner}</bdi>]} />,
      danger: true,
      onYes: () => apply(putKey),
    });
  }

  function askRemove(current: RepoKey) {
    setFailure(null);
    confirmation.ask({
      ...t.repoHost.confirm.remove,
      effect: <Phrase words={t.repoHost.confirm.remove.effect} values={[<bdi>{current.owner}</bdi>]} />,
      final: true,
      danger: true,
      onYes: () => apply(async () => (await api.del(path), null)),
    });
  }

  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;

  const content = mode === 'edit' ? (
    <form className="repo-form" onSubmit={save}>
      <Field label={t.repoHost.owner} hint={t.repoHost.ownerHint}>{p => <input {...p} {...NOT_A_LOGIN} value={owner} onChange={e => setOwner(e.target.value)} maxLength={100} autoComplete="off" required />}</Field>
      <Field label={t.repoHost.key} hint={saved ? t.repoHost.keyKeep : t.repoHost.keyHint}>
        {p => <SecretInput {...p} value={token} onChange={e => setToken(e.target.value)} maxLength={500} />}
      </Field>
      <div className="form-foot">
        <button className="btn" type="submit" disabled={busy || !owner.trim() || (!saved && !token.trim())}>{t.common.save}</button>
        <button className="btn ghost" type="button" onClick={() => setMode('view')}>{t.common.cancel}</button>
      </div>
      {alert}
    </form>
  ) : (
    <div className="repo">
      <p>{says}</p>
      {saved ? (
        <div className="repo-actions">
          <button className="btn small ghost" type="button" onClick={edit}>{t.repoHost.change}</button>
          <button className="btn small ghost danger" type="button" onClick={() => askRemove(saved)}>{t.repoHost.remove}</button>
        </div>
      ) : (
        <div className="repo-actions">
          <button className={firstClass} type="button" onClick={edit}>{first}</button>
        </div>
      )}
      {alert}
    </div>
  );

  return <>{content}{confirmation.question}</>;
}

/* The whole company's key, as a card of the Integrations group: connected while a key is saved, shown once it is read. */
export function RepoHostCard() {
  const t = useT();
  const [host, setHost] = useState<RepoKey | null | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ host: RepoKey | null }>('/api/repo-host')
      .then(found => setHost(found.host))
      .catch(setFailure);
  }, []);

  if (host === undefined && failure === null) return null;
  const says = host ? <Idents text={t.repoHost.saved(host.owner, host.tokenLast4)} idents={[host.owner]} /> : t.repoHost.none;
  return (
    <IntegrationCard name={t.repoHost.title} about={t.repoHost.about} connected={Boolean(host)}>
      {host !== undefined && <KeyPart path="/api/repo-host" saved={host} says={says} first={t.repoHost.save} firstClass="btn small" onSaved={setHost} />}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </IntegrationCard>
  );
}

/* A department's own key, or the company's it uses, on the department's screen for the people who set its repositories. */
export function DepartmentRepoHost({ departmentId, host }: { departmentId: string; host: RepoHost | null }) {
  const t = useT();
  const id = useId();
  const says = !host ? t.repoHost.deptNone : host.own ? t.repoHost.deptOwn(host.owner, host.tokenLast4) : t.repoHost.deptCompany(host.owner);
  return (
    <section aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t.repoHost.title}</h3>
      <KeyPart path={`/api/departments/${departmentId}/repo-host`} saved={host?.own ? host : null} says={says} first={host ? t.repoHost.own : t.repoHost.save} firstClass="btn small ghost" />
    </section>
  );
}
