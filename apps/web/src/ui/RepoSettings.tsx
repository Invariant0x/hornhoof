import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Repository } from '../types';
import { Field } from './Field';

type Props = {
  /* The department or product whose agents clone it. */
  placeId: string;
  repository: Repository | null | undefined;
  /* A product's line shows only its button until it has a repository of its own. */
  compact?: boolean;
};

/* The repository a department's or product's agents clone, for people who see the whole company. An empty token keeps the saved one. */
export function RepoSettings({ placeId, repository, compact = false }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const path = `/api/departments/${placeId}/repository`;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setEditing(false);
      setAsking(false);
      setToken('');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function edit() {
    setUrl(repository?.url ?? '');
    setBranch(repository?.branch ?? 'main');
    setToken('');
    setAuthorName(repository?.author?.name ?? '');
    setAuthorEmail(repository?.author?.email ?? '');
    setFailure(null);
    setEditing(true);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    /* Both fields name the author; both empty take a saved one away. */
    const author = authorName.trim() ? { author: { name: authorName.trim(), email: authorEmail.trim() } } : repository?.author ? { author: null } : {};
    const body = { url: url.trim(), branch: branch.trim() || 'main', ...(token.trim() ? { token: token.trim() } : {}), ...author };
    void run(() => api.put(path, body));
  }

  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;

  if (editing) {
    return (
      <form className="repo-form" onSubmit={save}>
        <Field label={t.dept.address}>{p => <input {...p} value={url} onChange={e => setUrl(e.target.value)} maxLength={500} placeholder="https://github.com/acme/shop.git" required />}</Field>
        <Field label={t.dept.branch}>{p => <input {...p} value={branch} onChange={e => setBranch(e.target.value)} maxLength={200} />}</Field>
        <Field label={t.dept.token} hint={repository?.tokenLast4 ? t.dept.tokenKeep : t.dept.tokenHint}>
          {p => <input {...p} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} maxLength={500} />}
        </Field>
        <Field label={t.dept.authorName} hint={t.dept.authorHint}>{p => <input {...p} value={authorName} onChange={e => setAuthorName(e.target.value)} maxLength={100} placeholder="Ivan Korol" />}</Field>
        <Field label={t.dept.authorEmail}>{p => <input {...p} type="email" value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} maxLength={200} />}</Field>
        <div className="repo-actions">
          <button className="btn small" type="submit" disabled={busy || !url.trim() || !authorName.trim() !== !authorEmail.trim()}>{t.common.save}</button>
          <button className="btn small ghost" type="button" onClick={() => setEditing(false)}>{t.common.cancel}</button>
        </div>
        {alert}
      </form>
    );
  }

  if (!repository) {
    return (
      <div className="repo">
        {!compact && <p className="muted">{t.dept.noRepository}</p>}
        <button className="btn small ghost" type="button" onClick={edit}>{t.dept.addRepository}</button>
        {alert}
      </div>
    );
  }

  return (
    <div className="repo">
      <span className="repo-url">{repository.url}</span>
      <small>{t.dept.branchIs(repository.branch)}</small>
      <small>{repository.tokenLast4 ? t.dept.tokenEnding(repository.tokenLast4) : t.dept.noToken}</small>
      {repository.author && <small>{t.dept.commitsAs(repository.author.name, repository.author.email)}</small>}
      {asking ? (
        <div className="repo-actions">
          <span>{t.dept.removeAsk}</span>
          <button className="btn small" type="button" disabled={busy} onClick={() => void run(() => api.del(path))}>{t.dept.yesRemove}</button>
          <button className="btn small ghost" type="button" onClick={() => setAsking(false)}>{t.tasks.keep}</button>
        </div>
      ) : (
        <div className="repo-actions">
          <button className="btn small ghost" type="button" onClick={edit}>{t.dept.change}</button>
          <button className="btn small ghost" type="button" onClick={() => setAsking(true)}>{t.dept.remove}</button>
        </div>
      )}
      {alert}
    </div>
  );
}
