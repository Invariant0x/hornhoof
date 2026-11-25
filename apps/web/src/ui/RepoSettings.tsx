import { useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Department, Repository } from '../types';
import { Field } from './Field';
import { DepartmentRepoHost } from './RepoHost';
import { NOT_A_LOGIN, SecretInput } from './SecretInput';

type Props = {
  /* The department or product whose agents clone it. */
  placeId: string;
  repository: Repository | null | undefined;
  /* A product's line shows only its button until it has a repository of its own. */
  compact?: boolean;
};

const savedCommand = (repository: Repository | null | undefined) => repository?.fullTestCommand ?? '';

/* Sent only when it changed; an empty field says there is no such command. */
function commandChange(typed: string, saved: string) {
  const command = typed.trim();
  return command === saved ? {} : { fullTestCommand: command || null };
}

const savedWorkflow = (repository: Repository | null | undefined) => repository?.releaseWorkflow ?? '';

/* Sent only when it changed; an empty field says there is none named. */
function workflowChange(typed: string, saved: string) {
  const path = typed.trim();
  return path === saved ? {} : { releaseWorkflow: path || null };
}

function FullCommandLine({ command }: { command: string }) {
  const t = useT();
  return <small className="repo-command">{command ? t.dept.fullCommandIs(command) : t.dept.noFullCommand}</small>;
}

/* The repository a department's or product's agents clone, for people who see the whole company. An empty token keeps the saved one. */
export function RepoSettings({ placeId, repository, compact = false }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [memory, setMemory] = useState('');
  const [fullCommand, setFullCommand] = useState('');
  const [releaseWorkflow, setReleaseWorkflow] = useState('');
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
    setMemory(repository?.testMemoryGb ? String(repository.testMemoryGb) : '');
    setFullCommand(savedCommand(repository));
    setReleaseWorkflow(savedWorkflow(repository));
    setFailure(null);
    setEditing(true);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    /* Both fields name the author; both empty take a saved one away. */
    const author = authorName.trim() ? { author: { name: authorName.trim(), email: authorEmail.trim() } } : repository?.author ? { author: null } : {};
    /* Sent only when it changed; an empty field takes the default again. */
    const gb = memory.trim() ? Number(memory) : null;
    const testMemory = gb !== (repository?.testMemoryGb ?? null) ? { testMemoryGb: gb } : {};
    const body = { url: url.trim(), branch: branch.trim() || 'main', ...(token.trim() ? { token: token.trim() } : {}), ...author, ...testMemory, ...commandChange(fullCommand, savedCommand(repository)), ...workflowChange(releaseWorkflow, savedWorkflow(repository)) };
    void run(() => api.put(path, body));
  }

  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;

  if (editing) {
    return (
      <form className="repo-form" onSubmit={save}>
        <Field label={t.dept.address}>{p => <input {...p} {...NOT_A_LOGIN} value={url} onChange={e => setUrl(e.target.value)} maxLength={500} placeholder="https://github.com/acme/shop.git" autoComplete="off" required />}</Field>
        <Field label={t.dept.branch}>{p => <input {...p} {...NOT_A_LOGIN} value={branch} onChange={e => setBranch(e.target.value)} maxLength={200} autoComplete="off" />}</Field>
        <Field label={t.dept.token} hint={repository?.tokenLast4 ? t.dept.tokenKeep : t.dept.tokenHint}>
          {p => <SecretInput {...p} value={token} onChange={e => setToken(e.target.value)} maxLength={500} />}
        </Field>
        <Field label={t.dept.authorName} hint={t.dept.authorHint}>{p => <input {...p} {...NOT_A_LOGIN} value={authorName} onChange={e => setAuthorName(e.target.value)} maxLength={100} placeholder={t.dept.authorPlaceholder} autoComplete="off" />}</Field>
        <Field label={t.dept.authorEmail}>{p => <input {...p} {...NOT_A_LOGIN} type="email" value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} maxLength={200} autoComplete="off" />}</Field>
        <Field label={t.dept.testMemory} hint={t.dept.testMemoryHint}>{p => <input {...p} {...NOT_A_LOGIN} type="number" min={1} max={512} step={1} value={memory} onChange={e => setMemory(e.target.value)} autoComplete="off" />}</Field>
        <Field label={t.dept.fullCommand} hint={t.dept.fullCommandHint}>{p => <input {...p} {...NOT_A_LOGIN} value={fullCommand} onChange={e => setFullCommand(e.target.value)} maxLength={4000} autoComplete="off" />}</Field>
        <Field label={t.dept.releaseWorkflow} hint={t.dept.releaseWorkflowHint}>{p => <input {...p} {...NOT_A_LOGIN} value={releaseWorkflow} onChange={e => setReleaseWorkflow(e.target.value)} maxLength={250} placeholder=".github/workflows/release.yml" autoComplete="off" />}</Field>
        <div className="form-foot">
          <button className="btn" type="submit" disabled={busy || !url.trim() || !authorName.trim() !== !authorEmail.trim()}>{t.common.save}</button>
          <button className="btn ghost" type="button" onClick={() => setEditing(false)}>{t.common.cancel}</button>
        </div>
        {alert}
      </form>
    );
  }

  if (!repository) {
    return (
      <div className="repo">
        {!compact && <p className="muted">{t.dept.noRepository}</p>}
        <button className="btn small ghost" type="button" onClick={edit}>{t.dept.connectRepository}</button>
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
      {repository.testMemoryGb !== undefined && <small>{t.dept.testMemoryIs(repository.testMemoryGb)}</small>}
      <FullCommandLine command={savedCommand(repository)} />
      <small className="repo-command">{savedWorkflow(repository) ? t.dept.releaseWorkflowIs(savedWorkflow(repository)) : t.dept.noReleaseWorkflow}</small>
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

/* The name a new repository's product takes unless another is typed: the end of its address, as the server takes it. */
const nameOf = (url: string) => (url.trim().replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.git$/i, '').slice(0, 60);

/* Another repository of a department: it comes as a new product of the department, which its tasks then name. */
function AddRepository({ departmentId }: { departmentId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const shownName = name ?? nameOf(url);

  function close() {
    setOpen(false);
    setName(null);
    setUrl('');
    setBranch('main');
    setToken('');
    setAuthorName('');
    setAuthorEmail('');
    setFailure(null);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const author = authorName.trim() ? { author: { name: authorName.trim(), email: authorEmail.trim() } } : {};
    const body = { ...(shownName.trim() ? { name: shownName.trim() } : {}), url: url.trim(), branch: branch.trim() || 'main', ...(token.trim() ? { token: token.trim() } : {}), ...author };
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/api/departments/${departmentId}/repositories`, body);
      close();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="repo-actions">
        <button className="btn small ghost" type="button" onClick={() => setOpen(true)}>{t.dept.addRepository}</button>
      </div>
    );
  }
  return (
    <form className="repo-form" aria-label={t.dept.addRepository} onSubmit={e => void add(e)}>
      <p className="muted">{t.dept.addRepositoryHow}</p>
      <Field label={t.dept.address}>{p => <input {...p} {...NOT_A_LOGIN} value={url} onChange={e => setUrl(e.target.value)} maxLength={500} placeholder="https://github.com/acme/shop.git" autoComplete="off" required />}</Field>
      <Field label={t.dept.repoName} hint={t.dept.repoNameHint}>{p => <input {...p} {...NOT_A_LOGIN} value={shownName} onChange={e => setName(e.target.value)} maxLength={60} autoComplete="off" />}</Field>
      <Field label={t.dept.branch}>{p => <input {...p} {...NOT_A_LOGIN} value={branch} onChange={e => setBranch(e.target.value)} maxLength={200} autoComplete="off" />}</Field>
      <Field label={t.dept.token} hint={t.dept.tokenHint}>
        {p => <SecretInput {...p} value={token} onChange={e => setToken(e.target.value)} maxLength={500} />}
      </Field>
      <Field label={t.dept.authorName} hint={t.dept.authorHint}>{p => <input {...p} {...NOT_A_LOGIN} value={authorName} onChange={e => setAuthorName(e.target.value)} maxLength={100} placeholder={t.dept.authorPlaceholder} autoComplete="off" />}</Field>
      <Field label={t.dept.authorEmail}>{p => <input {...p} {...NOT_A_LOGIN} type="email" value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} maxLength={200} autoComplete="off" />}</Field>
      <div className="form-foot">
        <button className="btn" type="submit" disabled={busy || !url.trim() || !authorName.trim() !== !authorEmail.trim()}>{t.dept.addThis}</button>
        <button className="btn ghost" type="button" onClick={close}>{t.common.cancel}</button>
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </form>
  );
}

/* The repositories a department's agents work in, for the people who set them: the department's own first, which a task
   with no product changes, then one on each product. Another one comes as a new product. Below, the GitHub key the
   orchestrator creates them with. */
export function Repositories({ department }: { department: Pick<Department, 'id' | 'repository' | 'products' | 'repoHost'> }) {
  const t = useT();
  const id = useId();
  return (
    <>
      <section aria-labelledby={`${id}-repos`}>
        <h3 id={`${id}-repos`}>{t.dept.repositories}</h3>
        <p className="muted">{t.dept.repositoriesAbout}</p>
        <ul className="dv-list">
          <li aria-labelledby={`${id}-own`}>
            <b id={`${id}-own`}>{t.dept.ownRepository}</b>
            <RepoSettings placeId={department.id} repository={department.repository} />
          </li>
          {department.products.map(p => (
            <li key={p.id} aria-labelledby={`${id}-${p.id}`}>
              <b id={`${id}-${p.id}`}>{p.name}</b>
              <RepoSettings placeId={p.id} repository={p.repository} compact />
            </li>
          ))}
        </ul>
        <AddRepository departmentId={department.id} />
      </section>
      <DepartmentRepoHost departmentId={department.id} host={department.repoHost ?? null} />
    </>
  );
}
