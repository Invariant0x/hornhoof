import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, Phrase, useLanguage, useT, type Messages } from '../i18n';
import { useConfirmAction } from './ConfirmAction';
import { Field } from './Field';
import { NOT_A_LOGIN, SecretInput } from './SecretInput';
import { TickBox } from './TickBox';

/* The company's saved site sign-ins: any person adds, changes and removes one, and every employee and assistant of the
   company takes it to sign in. The password and the code secret are typed here and never shown again. */

type Who = { id: string; name: string } | null;
export type VaultEntry = { id: string; name: string; site: string; login: string; hasCode: boolean; createdBy: Who; createdAt: string };
type LogLine = { id: string; kind: 'created' | 'changed' | 'removed' | 'taken'; person: Who; agent: Who; task: { id: string; number: number | null } | null; at: string };

type Mode = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; entry: VaultEntry } | { kind: 'log'; entry: VaultEntry; lines: LogLine[] | null };
type FieldName = 'name' | 'site' | 'login' | 'password' | 'code';
type Draft = { name: string; site: string; login: string; password: string; code: string; removeCode: boolean };

/* What the window asks the server for: a server that keeps no vault shows no Passwords group. */
export const VAULT_PATH = '/api/vault';
const CODE = /^(otpauth:\/\/totp\/\S+|[A-Z2-7]{16,128})$/;
const codeOf = (text: string) => (/^otpauth:/i.test(text.trim()) ? text.trim() : text.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase());

const draftOf = (entry: VaultEntry | null): Draft => ({
  name: entry?.name ?? '',
  site: entry?.site ?? '',
  login: entry?.login ?? '',
  password: '',
  code: '',
  removeCode: false,
});

const ORDER: FieldName[] = ['name', 'site', 'login', 'password', 'code'];

function useWhen() {
  const { language } = useLanguage();
  return (iso: string) => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function vaultEditSummary(t: Messages, entry: VaultEntry, draft: Draft): { warnings: ReactNode[]; danger: boolean } {
  const e = t.vault.confirm.edit;
  const name = draft.name.trim();
  const site = draft.site.trim();
  const login = draft.login.trim();
  const warnings: ReactNode[] = [
    ...(draft.password ? [e.password] : []),
    ...(draft.code.trim() ? [e.code] : []),
    ...(draft.removeCode ? [e.removeCode] : []),
    ...(name !== entry.name ? [<Phrase words={e.rename} values={[<bdi>{name}</bdi>]} />] : []),
    ...(site !== entry.site ? [<Phrase words={e.site} values={[<bdi>{site}</bdi>]} />] : []),
    ...(login !== entry.login ? [<Phrase words={e.login} values={[<bdi>{login}</bdi>]} />] : []),
  ];
  return { warnings, danger: Boolean(draft.password || draft.code.trim() || draft.removeCode) };
}

/* The form of one entry: a new one, or the change of one, where an empty password or code keeps the stored one. */
function EntryForm({ entry, onSaved, onCancel }: { entry: VaultEntry | null; onSaved(): void; onCancel(): void }) {
  const t = useT();
  const v = t.vault;
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirmation = useConfirmAction();
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});
  const set = (change: Partial<Draft>) => setDraft(d => ({ ...d, ...change }));

  function check(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    if (!draft.name.trim()) found.name = v.needName;
    if (!draft.site.trim()) found.site = v.needSite;
    if (!draft.login.trim()) found.login = v.needLogin;
    if (!entry && !draft.password) found.password = v.needPassword;
    if (draft.code.trim() && !CODE.test(codeOf(draft.code))) found.code = v.badCode;
    return found;
  }

  function showProblems(found: Partial<Record<FieldName, string>>) {
    setProblems(found);
    const first = ORDER.find(name => found[name]);
    if (first) requestAnimationFrame(() => inputs.current[first]?.focus());
  }

  async function send(body: Record<string, unknown>) {
    try {
      if (entry) await api.patch(`/api/vault/${entry.id}`, body);
      else await api.post('/api/vault', body);
      onSaved();
    } catch (err) {
      if ((err as { reason?: string }).reason === 'vault_name_taken') setProblems({ name: v.nameTaken });
      throw err;
    }
  }

  async function saveDirect(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await send(body);
    } catch (err) {
      if ((err as { reason?: string }).reason === 'vault_name_taken') showProblems({ name: v.nameTaken });
      else setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const found = check();
    if (Object.keys(found).length) return showProblems(found);
    setProblems({});
    setFailure(null);
    const body = {
      name: draft.name.trim(), site: draft.site.trim(), login: draft.login.trim(),
      ...(draft.password ? { password: draft.password } : {}),
      ...(draft.code.trim() ? { code: draft.code.trim() } : {}),
      ...(entry && draft.removeCode ? { removeCode: true } : {}),
    };
    const summary = entry ? vaultEditSummary(t, entry, draft) : null;
    if (!entry || !summary?.warnings.length) return void saveDirect(body);
    confirmation.ask({
      title: v.confirm.edit.title,
      effect: <Phrase words={v.confirm.edit.effect} values={[<bdi>{entry.name}</bdi>]} />,
      warnings: summary.warnings,
      yes: v.confirm.edit.yes,
      working: v.confirm.edit.working,
      danger: summary.danger,
      onYes: () => send(body),
    });
  }

  const ref = (name: FieldName) => (el: HTMLInputElement | null) => void (inputs.current[name] = el);
  return (
    <>
      <form className="settings-form" onSubmit={submit} noValidate aria-label={entry ? v.changeTitle(entry.name) : v.addTitle}>
        <Field label={v.name} hint={v.nameHint} problem={problems.name}>
          {p => <input {...p} {...NOT_A_LOGIN} ref={ref('name')} value={draft.name} onChange={e => set({ name: e.target.value })} maxLength={80} autoComplete="off" />}
        </Field>
        <Field label={v.site} hint={v.siteHint} problem={problems.site}>
          {p => <input {...p} {...NOT_A_LOGIN} ref={ref('site')} value={draft.site} onChange={e => set({ site: e.target.value })} maxLength={2048} autoComplete="off" inputMode="url" spellCheck={false} />}
        </Field>
        <Field label={v.login} problem={problems.login}>
          {p => <input {...p} {...NOT_A_LOGIN} ref={ref('login')} value={draft.login} onChange={e => set({ login: e.target.value })} maxLength={320} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label={v.password} hint={entry ? v.passwordKeep : v.passwordHint} problem={problems.password}>
          {p => <SecretInput {...p} ref={ref('password')} value={draft.password} onChange={e => set({ password: e.target.value })} maxLength={1024} />}
        </Field>
        <Field label={v.code} hint={entry?.hasCode ? v.codeKeep : v.codeHint} problem={problems.code}>
          {p => <SecretInput {...p} ref={ref('code')} value={draft.code} onChange={e => set({ code: e.target.value })} maxLength={2048} />}
        </Field>
        {entry?.hasCode && (
          <label className="check-card">
            <TickBox checked={draft.removeCode} onChange={e => set({ removeCode: e.target.checked })} />
            <span><b>{v.removeCode}</b></span>
          </label>
        )}
        {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
        <div className="settings-actions">
          <button className="btn small" type="submit" disabled={busy}>{t.common.save}</button>
          <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
        </div>
      </form>
      {confirmation.question}
    </>
  );
}

function EntryLog({ entry, lines, onClose }: { entry: VaultEntry; lines: LogLine[] | null; onClose(): void }) {
  const t = useT();
  const v = t.vault;
  const when = useWhen();
  return (
    <section className="settings-part" aria-label={v.logTitle(entry.name)}>
      <h4>{v.logTitle(entry.name)}</h4>
      {lines === null ? (
        <p className="muted" role="status">{t.common.loading}</p>
      ) : (
        <ul className="vault-list">
          {lines.map(line => (
            <li key={line.id} className="vault-entry">
              <span>{v.logLine(line.kind, line.person?.name ?? line.agent?.name ?? '', line.task?.number ?? null)}</span>
              <small>{when(line.at)}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
      </div>
    </section>
  );
}

export function Vault() {
  const t = useT();
  const v = t.vault;
  const when = useWhen();
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();

  const load = () =>
    api.get<{ entries: VaultEntry[] }>(VAULT_PATH).then(
      res => {
        setEntries(res.entries);
        setFailure(null);
      },
      setFailure,
    );
  useEffect(() => void load(), []);

  function askRemove(entry: VaultEntry) {
    setFailure(null);
    confirmation.ask({
      ...v.confirm.remove,
      effect: <Phrase words={v.confirm.remove.effect} values={[<bdi>{entry.name}</bdi>]} />,
      final: true,
      danger: true,
      onYes: async () => {
        await api.del(`/api/vault/${entry.id}`);
        await load();
      },
    });
  }

  function openLog(entry: VaultEntry) {
    setMode({ kind: 'log', entry, lines: null });
    api.get<{ log: LogLine[] }>(`/api/vault/${entry.id}/log`).then(res => setMode({ kind: 'log', entry, lines: res.log }), setFailure);
  }

  const saved = () => {
    setMode({ kind: 'list' });
    void load();
  };

  if (mode.kind === 'add' || mode.kind === 'edit') {
    return (
      <div className="settings-group">
        <section className="settings-part">
          <h4>{mode.kind === 'add' ? v.addTitle : v.changeTitle(mode.entry.name)}</h4>
          <EntryForm entry={mode.kind === 'edit' ? mode.entry : null} onSaved={saved} onCancel={() => setMode({ kind: 'list' })} />
        </section>
      </div>
    );
  }
  return (
    <div className="settings-group">
      {mode.kind === 'log' ? (
        <EntryLog entry={mode.entry} lines={mode.lines} onClose={() => setMode({ kind: 'list' })} />
      ) : (
        <section className="settings-part">
          {entries === null && failure === null && <p className="muted" role="status">{t.common.loading}</p>}
          {entries?.length === 0 && <p className="muted">{v.none}</p>}
          {entries && entries.length > 0 && (
            <ul className="vault-list">
              {entries.map(entry => (
                <li key={entry.id} className="vault-entry">
                  <b>{entry.name}</b>
                  <span className="vault-site">{entry.site}</span>
                  <span>{v.loginIs(entry.login)}{entry.hasCode ? ` ${v.withCode}` : ''}</span>
                  <small>{entry.createdBy ? v.addedBy(entry.createdBy.name, when(entry.createdAt)) : v.added(when(entry.createdAt))}</small>
                  <div className="settings-actions">
                    <button className="btn small ghost" type="button" onClick={() => openLog(entry)}>{v.log}</button>
                    <button className="btn small ghost" type="button" onClick={() => setMode({ kind: 'edit', entry })}>{v.change}</button>
                    <button className="btn small ghost danger" type="button" onClick={() => askRemove(entry)}>{v.remove}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-actions">
            <button className="btn small" type="button" onClick={() => setMode({ kind: 'add' })}>{v.add}</button>
          </div>
        </section>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {confirmation.question}
    </div>
  );
}
