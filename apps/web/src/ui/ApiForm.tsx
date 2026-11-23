import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { deptLabel, errorText, Phrase, useT, type Messages } from '../i18n';
import { useOrg } from '../org';
import type { ModelOption, Org, SubView } from '../types';
import { subName } from './subscription';
import { BusyLabel } from './BusyLabel';
import { useConfirmAction, type Question } from './ConfirmAction';
import { Field, type InputProps } from './Field';
import { NOT_A_LOGIN, SecretInput } from './SecretInput';
import { TickBox } from './TickBox';

/* A company connects an API paid by the token, and changes its name, models and the place it serves: company scope
   anywhere, and a person who runs a department in that department alone, as the server checks. The key goes to the server
   once and never comes back; changing a connection asks for it no more. */

const PROVIDERS = ['anthropic_api', 'openai_api', 'openrouter', 'custom_api'] as const;
type ApiProvider = (typeof PROVIDERS)[number];
type Protocol = 'anthropic' | 'openai';
type Model = Pick<ModelOption, 'id' | 'name'>;
type Target = { kind: 'any' | 'orchestrator' } | { kind: 'department' | 'team'; id: string };

/* How many listed models the form shows at once; the search finds the rest. */
const SHOWN = 100;

const targetValue = (target: Target) => ('id' in target ? `${target.kind}:${target.id}` : target.kind);
function targetOf(value: string): Target {
  const [kind, id] = value.split(':');
  return id && (kind === 'department' || kind === 'team') ? { kind, id } : { kind: kind === 'orchestrator' ? 'orchestrator' : 'any' };
}
/* places: the departments a person who runs them may give a key to; null for anywhere. */
const startTarget = (sub: SubView | undefined, places: readonly string[] | null): Target => {
  const target = sub?.target;
  if (target && target.id && (target.kind === 'department' || target.kind === 'team')) return { kind: target.kind, id: target.id };
  if (places?.[0]) return { kind: 'department', id: places[0] };
  return { kind: target?.kind === 'orchestrator' ? 'orchestrator' : 'any' };
};
const ownModels = (sub?: SubView): Model[] => (sub?.models ?? []).map(({ id, name }) => ({ id, name }));
const isApi = (provider: string): provider is ApiProvider => (PROVIDERS as readonly string[]).includes(provider);

const deptScopes = (t: Messages, d: Org['departments'][number]): Array<[string, string]> => [
  [`department:${d.id}`, deptLabel(t, d)],
  ...d.teams.map((team): [string, string] => [`team:${team.id}`, `${deptLabel(t, d)}, ${team.name}`]),
];

const orgScopes = (t: Messages, org: Org | null): Array<[string, string]> =>
  org ? org.departments.flatMap(d => deptScopes(t, d)) : [];

function targetLabel(t: Messages, org: Org | null, value: string): string {
  const names = new Map<string, string>([
    ['any', t.subs.serves.any],
    ['orchestrator', t.subs.serves.orchestrator],
    ...orgScopes(t, org),
  ]);
  return names.get(value) ?? value;
}

function apiEditLines(t: Messages, org: Org | null, sub: SubView, label: string, scope: string, initialScope: string): ReactNode[] {
  const plan = <bdi>{subName(t, sub)}</bdi>;
  const lines: ReactNode[] = [];
  if (label !== (sub.label ?? '')) lines.push(<Phrase words={t.subs.confirm.editApi.rename} values={[plan, <bdi>{label}</bdi>]} />);
  if (scope !== initialScope) lines.push(<Phrase words={t.subs.confirm.editApi.target} values={[plan, <bdi>{targetLabel(t, org, scope)}</bdi>]} />);
  return lines;
}

function apiEditQuestion(t: Messages, org: Org | null, sub: SubView | undefined, label: string, scope: string, initialScope: string, onYes: () => Promise<void>): Question | null {
  if (!sub) return null;
  const lines = apiEditLines(t, org, sub, label, scope, initialScope);
  if (!lines.length) return null;
  return {
    title: t.subs.confirm.editApi.title,
    effect: lines[0],
    warnings: lines.slice(1),
    yes: t.subs.confirm.editApi.yes,
    working: t.subs.confirm.editApi.working,
    onYes,
  };
}

function ScopeField({ value, places, onChange }: { value: string; places: readonly string[] | null; onChange(value: string): void }) {
  const t = useT();
  const { org } = useOrg();
  const shown = (org?.departments ?? []).filter(d => places === null || places.includes(d.id));
  return (
    <Field label={t.subs.apiServes}>
      {p => (
        <select {...p} className="sel" value={value} onChange={e => onChange(e.target.value)}>
          {places === null && <option value="any">{t.subs.serves.any}</option>}
          {places === null && <option value="orchestrator">{t.subs.serves.orchestrator}</option>}
          {shown.map(d => (
            <optgroup key={d.id} label={deptLabel(t, d)}>
              {deptScopes(t, d).map(([option, text]) => <option key={option} value={option}>{text}</option>)}
            </optgroup>
          ))}
        </select>
      )}
    </Field>
  );
}

/* The models the connection runs: the ones kept, the API's list to tick from, and an id written by hand. */
function ModelsField({ models, setModels, load }: { models: Model[]; setModels(models: Model[]): void; load(): Promise<Model[]> }) {
  const t = useT();
  const [listed, setListed] = useState<Model[] | null>(null);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kept = new Set(models.map(m => m.id));
  const toggle = (model: Model) => setModels(kept.has(model.id) ? models.filter(m => m.id !== model.id) : [...models, model]);
  const add = () => {
    const id = typed.trim();
    if (id && !kept.has(id)) setModels([...models, { id, name: id }]);
    setTyped('');
  };
  async function ask() {
    setBusy(true);
    setProblem(null);
    try {
      setListed(await load());
    } catch (err) {
      setProblem(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }
  const found = (listed ?? []).filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, SHOWN);
  return (
    <div className="field">
      <span className="label">{t.subs.apiModels}</span>
      <div className="field-control api-models">
        {models.length ? (
          <ul className="model-list">
            {models.map(m => (
              <li key={m.id}>
                <span className="nm"><b>{m.name}</b>{m.name !== m.id && <small>{m.id}</small>}</span>
                <button className="btn ghost small" type="button" aria-label={t.subs.removeModel(m.name)} onClick={() => toggle(m)}>{t.subs.remove}</button>
              </li>
            ))}
          </ul>
        ) : <span className="hint">{t.subs.noModels}</span>}
        <span className="hint">{t.subs.apiModelsHint}</span>
        <div className="model-actions">
          <button className="btn ghost" type="button" aria-busy={busy} disabled={busy} onClick={() => void ask()}>
            <BusyLabel busy={busy} idle={t.subs.loadModels} working={t.subs.loadingModels} />
          </button>
        </div>
        {problem && <p className="alert" role="alert">{problem}</p>}
        {listed && (
          <>
            <span className="hint">{t.subs.modelsFound(listed.length)}</span>
            {listed.length > 12 && <input {...NOT_A_LOGIN} type="search" autoComplete="off" aria-label={t.subs.findModel} placeholder={t.subs.findModel} value={query} onChange={e => setQuery(e.target.value)} />}
            <ul className="model-found">
              {found.map(m => (
                <li key={m.id}>
                  <label><TickBox checked={kept.has(m.id)} onChange={() => toggle(m)} /><span>{m.name}</span></label>
                </li>
              ))}
            </ul>
          </>
        )}
        <Field label={t.subs.modelId}>
          {p => (
            <div className="model-add">
              <input {...p} {...NOT_A_LOGIN} className="mono" autoComplete="off" spellCheck={false} value={typed} onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
              <button className="btn ghost" type="button" disabled={!typed.trim()} onClick={add}>{t.subs.addModel}</button>
            </div>
          )}
        </Field>
      </div>
    </div>
  );
}

/* The key the person types, which they may show while they type it. Only this one: a saved key never comes back. */
function TypedKey({ field, value, change }: { field: InputProps; value: string; change: (value: string) => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const button = shown ? t.subs.hideTypedKey : t.subs.showTypedKey;
  return <div className="keybox">
    <SecretInput {...field} className="mono" shown={shown} value={value} onChange={e => change(e.target.value)} />
    <button className="show" type="button" aria-label={button.label} onClick={() => setShown(!shown)}>{button.word}</button>
  </div>;
}

/* A new connection: its service, name, key, and for a compatible API its address and protocol. */
function NewFields({ form, set }: { form: NewForm; set(patch: Partial<NewForm>): void }) {
  const t = useT();
  return <>
    <Field label={t.subs.apiService}>
      {p => (
        <select {...p} className="sel" value={form.provider} onChange={e => set({ provider: e.target.value as ApiProvider })}>
          {PROVIDERS.map(provider => <option key={provider} value={provider}>{t.subs.apiProviders[provider]}</option>)}
        </select>
      )}
    </Field>
    <Field label={t.subs.apiKey} hint={t.subs.apiKeyHint}>
      {p => <TypedKey field={p} value={form.apiKey} change={apiKey => set({ apiKey })} />}
    </Field>
    {form.provider === 'custom_api' && (
      <Field label={t.subs.apiAddress} hint={t.subs.apiAddressHint}>
        {p => <input {...p} {...NOT_A_LOGIN} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={form.baseUrl} onChange={e => set({ baseUrl: e.target.value })} />}
      </Field>
    )}
    {(form.provider === 'custom_api' || form.provider === 'openrouter') && (
      <Field label={t.subs.apiProtocol}>
        {p => (
          <select {...p} className="sel" value={form.protocol} onChange={e => set({ protocol: e.target.value as Protocol })}>
            <option value="anthropic">{t.subs.protocols.anthropic}</option>
            <option value="openai">{t.subs.protocols.openai}</option>
          </select>
        )}
      </Field>
    )}
  </>;
}

type NewForm = { provider: ApiProvider; apiKey: string; baseUrl: string; protocol: Protocol };

function apiFormBody(sub: SubView | undefined, fresh: NewForm, label: string, scope: string, models: Model[]) {
  const target = targetOf(scope);
  if (sub) return { label: label.trim(), target, models };
  const custom = fresh.provider === 'custom_api';
  return {
    kind: 'api_key', provider: fresh.provider, label: label.trim(), apiKey: fresh.apiKey.trim(), target,
    ...(custom ? { baseUrl: fresh.baseUrl.trim() } : {}),
    ...(custom || fresh.provider === 'openrouter' ? { protocol: fresh.protocol } : {}),
    ...(models.length ? { models } : {}),
  };
}

/* sub: the connection to change; without it the form connects a new one. */
export function ApiForm({ sub, places = null, onSaved, onCancel }: { sub?: SubView; places?: readonly string[] | null; onSaved(sub: SubView): void; onCancel(): void }) {
  const t = useT();
  const { org } = useOrg();
  const editing = Boolean(sub);
  const initialScope = targetValue(startTarget(sub, places));
  const [fresh, setFresh] = useState<NewForm>({ provider: 'anthropic_api', apiKey: '', baseUrl: '', protocol: 'anthropic' });
  const [label, setLabel] = useState(sub?.label ?? '');
  const [scope, setScope] = useState(initialScope);
  const [models, setModels] = useState<Model[]>(ownModels(sub));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const confirmation = useConfirmAction();
  const set = (patch: Partial<NewForm>) => setFresh(was => ({ ...was, ...patch }));
  const custom = fresh.provider === 'custom_api';
  const title = sub ? t.subs.editApiLabel(subName(t, sub)) : t.subs.connectApi;

  async function load(): Promise<Model[]> {
    if (sub) return (await api.post<{ models: Model[] }>(`/api/subscriptions/${sub.id}/models`)).models;
    const where = custom ? { baseUrl: fresh.baseUrl.trim(), protocol: fresh.protocol } : {};
    return (await api.post<{ models: Model[] }>('/api/subscriptions/models', { provider: fresh.provider, apiKey: fresh.apiKey.trim(), ...where })).models;
  }

  async function send() {
    const payload = apiFormBody(sub, fresh, label, scope, models);
    const { subscription } = sub
      ? await api.patch<{ subscription: SubView }>(`/api/subscriptions/${sub.id}`, payload)
      : await api.post<{ subscription: SubView }>('/api/subscriptions', payload);
    onSaved(subscription);
  }

  async function saveDirect() {
    setBusy(true);
    setProblem(null);
    try {
      await send();
    } catch (err) {
      setProblem(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const question = apiEditQuestion(t, org, sub, label.trim(), scope, initialScope, send);
    if (!question) return void saveDirect();
    setProblem(null);
    confirmation.ask(question);
  }

  const ready = label.trim() && (editing || (fresh.apiKey.trim().length >= 8 && (!custom || fresh.baseUrl.trim())));
  return (
    <>
      <form className="key-form form-grid api-form" aria-label={title} onSubmit={save}>
        {!editing && <NewFields form={fresh} set={set} />}
        <Field label={t.subs.apiName}>
          {p => <input {...p} {...NOT_A_LOGIN} autoComplete="off" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} />}
        </Field>
        {(editing ? sub && isApi(sub.provider) : true) && <ModelsField models={models} setModels={setModels} load={load} />}
        <ScopeField value={scope} places={places} onChange={setScope} />
        {problem && <p className="alert" role="alert">{problem}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || !ready}>
            <BusyLabel busy={busy} idle={editing ? t.subs.saveChanges : t.subs.saveApi} working={editing ? t.subs.savingChanges : t.subs.savingApi} />
          </button>
          <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
        </div>
      </form>
      {confirmation.question}
    </>
  );
}
