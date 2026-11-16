import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import type { Me } from '../types';
import { Field } from './Field';
import { TickBox } from './TickBox';

/* The company's saved site sign-ins: any person adds one, every agent of the company may use it unless it is kept for a
   department or an agent, and the password and code secret are typed here only, never shown again. */

type Who = { id: string; name: string } | null;
type Scope = { kind: 'company' } | { kind: 'department'; departmentId: string; departmentName: string } | { kind: 'agent'; agentId: string; agentName: string };
export type VaultEntry = { id: string; name: string; site: string; login: string; hasCode: boolean; scope: Scope; createdBy: Who; createdAt: string; updatedBy: Who; updatedAt: string };
type LogLine = { id: string; kind: 'used' | 'created' | 'changed' | 'removed'; person: Who; agent: Who; task: { id: string; number: number | null } | null; target: 'browser' | 'phone' | null; status: string | null; at: string };

type Mode = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; entry: VaultEntry } | { kind: 'remove'; entry: VaultEntry } | { kind: 'log'; entry: VaultEntry; lines: LogLine[] | null };
type FieldName = 'name' | 'site' | 'login' | 'password' | 'code' | 'scopeTarget';
type Draft = { name: string; site: string; login: string; password: string; code: string; removeCode: boolean; scopeKind: Scope['kind']; scopeTarget: string };

/* What the window asks the server for: a server that keeps no vault shows no Passwords group. */
export const VAULT_PATH = '/api/vault';
const PASSWORD_MIN = 4;
const CODE = /^(otpauth:\/\/totp\/\S+|[A-Z2-7]{16,128})$/;
const codeOf = (text: string) => (/^otpauth:/i.test(text.trim()) ? text.trim() : text.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase());

const draftOf = (entry: VaultEntry | null): Draft => ({
  name: entry?.name ?? '',
  site: entry?.site ?? '',
  login: entry?.login ?? '',
  password: '',
  code: '',
  removeCode: false,
  scopeKind: entry?.scope.kind ?? 'company',
  scopeTarget: entry?.scope.kind === 'department' ? entry.scope.departmentId : entry?.scope.kind === 'agent' ? entry.scope.agentId : '',
});

const ORDER: FieldName[] = ['name', 'site', 'login', 'password', 'code', 'scopeTarget'];

function useWhen() {
  const { language } = useLanguage();
  return (iso: string) => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

/* The form of one entry: a new one, or the change of one, where an empty password or code keeps the stored one. */
function EntryForm({ entry, onSaved, onCancel }: { entry: VaultEntry | null; onSaved(): void; onCancel(): void }) {
  const t = useT();
  const v = t.vault;
  const { org } = useOrg();
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | HTMLSelectElement | null>>>({});
  const set = (change: Partial<Draft>) => setDraft(d => ({ ...d, ...change }));
  const departments = org?.departments ?? [];
  const agents = departments.flatMap(d => d.employees.map(e => ({ id: e.id, name: e.name })));

  function check(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    if (!draft.name.trim()) found.name = v.needName;
    if (!draft.site.trim()) found.site = v.needSite;
    if (!draft.login.trim()) found.login = v.needLogin;
    if ((!entry && !draft.password) || (draft.password && draft.password.length < PASSWORD_MIN)) found.password = v.needPassword(PASSWORD_MIN);
    if (draft.code.trim() && !CODE.test(codeOf(draft.code))) found.code = v.badCode;
    if (draft.scopeKind !== 'company' && !draft.scopeTarget) found.scopeTarget = draft.scopeKind === 'department' ? v.needDepartment : v.needAgent;
    return found;
  }

  function showProblems(found: Partial<Record<FieldName, string>>) {
    setProblems(found);
    const first = ORDER.find(name => found[name]);
    if (first) requestAnimationFrame(() => inputs.current[first]?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = check();
    if (Object.keys(found).length) return showProblems(found);
    setProblems({});
    setFailure(null);
    setBusy(true);
    const scope = draft.scopeKind === 'company' ? { kind: 'company' } : draft.scopeKind === 'department' ? { kind: 'department', departmentId: draft.scopeTarget } : { kind: 'agent', agentId: draft.scopeTarget };
    const body = {
      name: draft.name.trim(), site: draft.site.trim(), login: draft.login.trim(), scope,
      ...(draft.password ? { password: draft.password } : {}),
      ...(draft.code.trim() ? { code: draft.code.trim() } : {}),
      ...(entry && draft.removeCode ? { removeCode: true } : {}),
    };
    try {
      if (entry) await api.patch(`/api/vault/${entry.id}`, body);
      else await api.post('/api/vault', body);
      onSaved();
    } catch (err) {
      if ((err as { reason?: string }).reason === 'vault_name_taken') showProblems({ name: v.nameTaken });
      else setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const ref = (name: FieldName) => (el: HTMLInputElement | HTMLSelectElement | null) => void (inputs.current[name] = el);
  return (
    <form className="settings-form" onSubmit={e => void submit(e)} noValidate aria-label={entry ? v.changeTitle(entry.name) : v.addTitle}>
      <Field label={v.name} hint={v.nameHint} problem={problems.name}>
        {p => <input {...p} ref={ref('name')} value={draft.name} onChange={e => set({ name: e.target.value })} maxLength={80} autoComplete="off" />}
      </Field>
      <Field label={v.site} hint={v.siteHint} problem={problems.site}>
        {p => <input {...p} ref={ref('site')} value={draft.site} onChange={e => set({ site: e.target.value })} maxLength={2048} autoComplete="off" inputMode="url" spellCheck={false} />}
      </Field>
      <Field label={v.login} problem={problems.login}>
        {p => <input {...p} ref={ref('login')} value={draft.login} onChange={e => set({ login: e.target.value })} maxLength={320} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label={v.password} hint={entry ? v.passwordKeep : v.passwordHint} problem={problems.password}>
        {p => <input {...p} ref={ref('password')} type="password" value={draft.password} onChange={e => set({ password: e.target.value })} maxLength={1024} autoComplete="new-password" />}
      </Field>
      <Field label={v.code} hint={entry?.hasCode ? v.codeKeep : v.codeHint} problem={problems.code}>
        {p => <input {...p} ref={ref('code')} type="password" value={draft.code} onChange={e => set({ code: e.target.value })} maxLength={2048} autoComplete="off" spellCheck={false} />}
      </Field>
      {entry?.hasCode && (
        <label className="check-card">
          <TickBox checked={draft.removeCode} onChange={e => set({ removeCode: e.target.checked })} />
          <span><b>{v.removeCode}</b></span>
        </label>
      )}
      <Field label={v.scope} hint={v.scopeHint}>
        {p => (
          <select {...p} value={draft.scopeKind} onChange={e => set({ scopeKind: e.target.value as Scope['kind'], scopeTarget: '' })}>
            <option value="company">{v.scopeCompany}</option>
            <option value="department">{v.scopeDepartment}</option>
            <option value="agent">{v.scopeAgent}</option>
          </select>
        )}
      </Field>
      {draft.scopeKind !== 'company' && (
        <Field label={draft.scopeKind === 'department' ? v.department : v.agent} problem={problems.scopeTarget}>
          {p => (
            <select {...p} ref={ref('scopeTarget')} value={draft.scopeTarget} onChange={e => set({ scopeTarget: e.target.value })}>
              <option value="">{v.choose}</option>
              {(draft.scopeKind === 'department' ? departments.map(d => ({ id: d.id, name: d.name ?? (d.templateKey ? t.templates[d.templateKey].name : d.roleCode) })) : agents).map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      <div className="settings-actions">
        <button className="btn small" type="submit" disabled={busy}>{t.common.save}</button>
        <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}

const scopeText = (v: ReturnType<typeof useT>['vault'], scope: Scope) =>
  scope.kind === 'department' ? v.keptForDepartment(scope.departmentName) : scope.kind === 'agent' ? v.keptForAgent(scope.agentName) : v.forEveryone;

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
        <ul className="outbound-list outbound-entries">
          {lines.map(line => (
            <li key={line.id} className="outbound-entry">
              <span>{v.logLine(line.kind, line.person?.name ?? line.agent?.name ?? '', line.task?.number ?? null, line.target, line.status)}</span>
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

export function Vault({ me }: { me: Me }) {
  const t = useT();
  const v = t.vault;
  const when = useWhen();
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mayChange = (entry: VaultEntry) => entry.createdBy?.id === me.person.id || me.person.isOwner || (Boolean(me.person.isCeoDelegate) && me.person.scopeKind === 'company');

  const load = () =>
    api.get<{ entries: VaultEntry[] }>(VAULT_PATH).then(
      res => {
        setEntries(res.entries);
        setFailure(null);
      },
      setFailure,
    );
  useEffect(() => void load(), []);

  async function remove(entry: VaultEntry) {
    setBusy(true);
    try {
      await api.del(`/api/vault/${entry.id}`);
      setMode({ kind: 'list' });
      await load();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
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
            <ul className="outbound-list outbound-entries">
              {entries.map(entry => (
                <li key={entry.id} className="outbound-entry">
                  <b>{entry.name}</b>
                  <span className="outbound-address">{entry.site}</span>
                  <span>{v.loginIs(entry.login)}{entry.hasCode ? ` ${v.withCode}` : ''}</span>
                  <small>{scopeText(v, entry.scope)}</small>
                  <small>{v.addedBy(entry.createdBy?.name ?? '', when(entry.createdAt))}</small>
                  {mode.kind === 'remove' && mode.entry.id === entry.id ? (
                    <div className="settings-actions">
                      <span className="entry-main">{v.removeAsk(entry.name)}</span>
                      <button className="btn small" type="button" disabled={busy} onClick={() => void remove(entry)}>{v.yesRemove}</button>
                      <button className="btn small ghost" type="button" onClick={() => setMode({ kind: 'list' })}>{v.keep}</button>
                    </div>
                  ) : (
                    <div className="settings-actions">
                      <button className="btn small ghost" type="button" onClick={() => openLog(entry)}>{v.log}</button>
                      {mayChange(entry) && <button className="btn small ghost" type="button" onClick={() => setMode({ kind: 'edit', entry })}>{v.change}</button>}
                      {mayChange(entry) && <button className="btn small ghost danger" type="button" onClick={() => setMode({ kind: 'remove', entry })}>{v.remove}</button>}
                    </div>
                  )}
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
    </div>
  );
}
