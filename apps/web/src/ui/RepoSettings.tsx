import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, Phrase, useT, type Messages } from '../i18n';
import type { Department, Repository } from '../types';
import { useConfirmAction, type Question } from './ConfirmAction';
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

function FullCommandLine({ command }: { command: string }) {
  const t = useT();
  return <small className="repo-command">{command ? t.dept.fullCommandIs(command) : t.dept.noFullCommand}</small>;
}

function repoUpdateLines(t: Messages, repository: Repository, nextUrl: string, nextBranch: string, tokenChanged: boolean): ReactNode[] {
  const u = t.dept.repoConfirm.update;
  const oldUrl = <bdi>{repository.url}</bdi>;
  const branchChanged = nextBranch !== repository.branch;
  if (nextUrl !== repository.url) {
    return [
      <Phrase words={u.url} values={[oldUrl, <bdi>{nextUrl}</bdi>]} />,
      ...(branchChanged ? [<Phrase words={u.branchNote} values={[<bdi>{nextBranch}</bdi>]} />] : []),
      ...(tokenChanged ? [u.tokenNote] : []),
    ];
  }
  if (branchChanged) {
    return [<Phrase words={u.branch} values={[oldUrl, <bdi>{nextBranch}</bdi>]} />, ...(tokenChanged ? [u.tokenNote] : [])];
  }
  return tokenChanged ? [<Phrase words={u.token} values={[oldUrl]} />] : [];
}

function repoUpdateQuestion(t: Messages, repository: Repository | null | undefined, nextUrl: string, nextBranch: string, tokenChanged: boolean, onYes: () => Promise<void>): Question | null {
  if (!repository) return null;
  const lines = repoUpdateLines(t, repository, nextUrl, nextBranch, tokenChanged);
  if (!lines.length) return null;
  return {
    title: t.dept.repoConfirm.update.title,
    effect: lines[0],
    warnings: lines.slice(1),
    yes: t.dept.repoConfirm.update.yes,
    working: t.dept.repoConfirm.update.working,
    onYes,
  };
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();
  const path = `/api/departments/${placeId}/repository`;

  async function apply(action: () => Promise<unknown>) {
    await action();
    setEditing(false);
    setToken('');
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await apply(action);
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
    setFailure(null);
    setEditing(true);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const nextUrl = url.trim();
    const nextBranch = branch.trim() || 'main';
    const nextToken = token.trim();
    /* Both fields name the author; both empty take a saved one away. */
    const author = authorName.trim() ? { author: { name: authorName.trim(), email: authorEmail.trim() } } : repository?.author ? { author: null } : {};
    /* Sent only when it changed; an empty field takes the default again. */
    const gb = memory.trim() ? Number(memory) : null;
    const testMemory = gb !== (repository?.testMemoryGb ?? null) ? { testMemoryGb: gb } : {};
    const body = { url: nextUrl, branch: nextBranch, ...(nextToken ? { token: nextToken } : {}), ...author, ...testMemory, ...commandChange(fullCommand, savedCommand(repository)) };
    const question = repoUpdateQuestion(t, repository, nextUrl, nextBranch, Boolean(nextToken), () => apply(() => api.put(path, body)));
    if (!question) return void run(() => api.put(path, body));
    setFailure(null);
    confirmation.ask(question);
  }

  function askRemove(current: Repository) {
    setFailure(null);
    confirmation.ask({
      ...t.dept.repoConfirm.remove,
      effect: <Phrase words={t.dept.repoConfirm.remove.effect} values={[<bdi>{current.url}</bdi>]} />,
      danger: true,
      onYes: () => apply(() => api.del(path)),
    });
  }

  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;

  const content = editing ? (
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
      <div className="form-foot">
        <button className="btn" type="submit" disabled={busy || !url.trim() || !authorName.trim() !== !authorEmail.trim()}>{t.common.save}</button>
        <button className="btn ghost" type="button" onClick={() => setEditing(false)}>{t.common.cancel}</button>
      </div>
      {alert}
    </form>
  ) : !repository ? (
    <div className="repo">
      {!compact && <p className="muted">{t.dept.noRepository}</p>}
      <button className="btn small ghost" type="button" onClick={edit}>{t.dept.connectRepository}</button>
      {alert}
    </div>
  ) : (
    <div className="repo">
      <span className="repo-url">{repository.url}</span>
      <small>{t.dept.branchIs(repository.branch)}</small>
      <small>{repository.tokenLast4 ? t.dept.tokenEnding(repository.tokenLast4) : t.dept.noToken}</small>
      {repository.author && <small>{t.dept.commitsAs(repository.author.name, repository.author.email)}</small>}
      {repository.testMemoryGb !== undefined && <small>{t.dept.testMemoryIs(repository.testMemoryGb)}</small>}
      <FullCommandLine command={savedCommand(repository)} />
      <div className="repo-actions">
        <button className="btn small ghost" type="button" onClick={edit}>{t.dept.change}</button>
        <button className="btn small ghost" type="button" onClick={() => askRemove(repository)}>{t.dept.remove}</button>
      </div>
      {alert}
    </div>
  );

  return <>{content}{confirmation.question}</>;
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
