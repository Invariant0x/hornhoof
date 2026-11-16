import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import type { Messages } from '../i18n/en';
import { Field } from './Field';
import { TickBox } from './TickBox';

/* A department's own outbound messages, for the people who run it: its channels with their mail accounts, limits and
   sending without a yes to each message, its catalog with what to publish or take back, and the log of who set what up.
   An account's password or key is typed here and goes to the server once; nothing of it ever comes back. */

type Policy = {
  timezone: string;
  accountDailyLimit: number;
  domainDailyLimit: number;
  sampling: { matureAfter: number; firstPerSegment: number; firstPerAuthor: number; everyNth: number };
  circuit: { windowHours: number; minimumSample: number; maxComplaints: number; maxRefusals: number; maxBounces: number };
  autoSend?: boolean;
};

type SetupAccount = { id: string; label: string; senderDomain: string; status: 'active' | 'invalid' | 'revoked'; author: { agentId: string; name: string } | null };

export type SetupChannel = {
  id: string;
  departmentId: string;
  name: string;
  adapter: 'smtp' | 'webhook';
  purpose: string;
  audience: 'direct' | 'public';
  status: 'new' | 'active' | 'stopped';
  canManage?: boolean;
  policy?: { revision: number; value: Policy } | null;
  accounts: SetupAccount[];
};

type Named = { id: string; name: string } | null;
type Revision = {
  id: string;
  revision: number;
  status: 'proposed' | 'published' | 'revoked';
  summary: string;
  createdAt: string;
  createdBy: { kind: 'person' | 'agent'; name: string | null };
  publishedBy: Named;
  publishedVia: Named;
};
type Entry = { entryId: string; kind: string; locale: string | null; channel: Named; current: number | null; revisions: Revision[] };
type LogEntry = { id: string; kind: keyof Messages['outboundSetup']['log']; channel: Named; detail: Record<string, unknown>; person: Named; agent: Named; at: string };

export type RunDepartment = { id: string; name: string | null; templateKey: keyof Messages['templates'] | null };

const errorOf = (t: Messages, err: unknown): string => (err instanceof ApiFailure && err.reason === 'outbound_invalid' ? t.outboundSetup.invalid : errorText(t, err));

/* A move that reloads what it changed, with its failure shown where it was made. */
function useMove(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const run = async (move: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await move();
      onDone();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, run };
}

function Failure({ failure }: { failure: unknown }) {
  const t = useT();
  return failure === null ? null : <p className="alert" role="alert">{errorOf(t, failure)}</p>;
}

/* The buttons of an entry, and the foot of a form: each a group at the end of its line. */
function EntryActions({ children }: { children: ReactNode }) {
  return <div className="entry-actions">{children}</div>;
}

function FormFoot({ children }: { children: ReactNode }) {
  return <div className="form-foot">{children}</div>;
}

/* A status in a frame of its own: its word says it, its colour only repeats it. */
const TONE: Record<string, 'active' | 'invited' | 'offline'> = { active: 'active', published: 'active', new: 'invited', proposed: 'invited', invalid: 'invited', stopped: 'offline', revoked: 'offline' };

function Status({ of, children }: { of: string; children: ReactNode }) {
  return <span className={`status ${TONE[of] ?? 'offline'}`}>{children}</span>;
}

/* Pieces of one line, the dot held to the piece before it, so that no line begins with it. */
const joined = (pieces: readonly (string | null | undefined | false)[]): string => pieces.filter(Boolean).join('\u00a0· ');

/* A mail account or a webhook for a channel. Its password or key leaves this form once and is forgotten here at once. */
function AccountForm({ channel, onDone, onCancel }: { channel: SetupChannel; onDone(): void; onCancel(): void }) {
  const t = useT();
  const s = t.outboundSetup;
  const [v, setV] = useState({ label: '', host: '', port: '465', security: 'tls', username: '', password: '', from: '', endpoint: '', signingKey: '' });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const { busy, failure, run } = useMove(onDone);
  const smtp = channel.adapter === 'smtp';
  function save(e: FormEvent) {
    e.preventDefault();
    const config = smtp
      ? { host: v.host.trim(), port: Number(v.port), security: v.security, username: v.username, password: v.password, from: v.from.trim() }
      : { endpoint: v.endpoint.trim(), signingKey: v.signingKey };
    setV({ ...v, password: '', signingKey: '' });
    void run(() => api.post('/api/outbound/accounts', { channelId: channel.id, label: v.label.trim(), config }));
  }
  return (
    <form className="repo-form" onSubmit={save} aria-label={smtp ? s.connectMail : s.connectHook}>
      <Field label={s.label} hint={s.labelHint}>{p => <input {...p} value={v.label} onChange={set('label')} maxLength={200} required />}</Field>
      {smtp ? (
        <>
          <Field label={s.host}>{p => <input {...p} value={v.host} onChange={set('host')} maxLength={253} autoComplete="off" required />}</Field>
          <Field label={s.port}>{p => <input {...p} value={v.port} onChange={set('port')} inputMode="numeric" pattern="[0-9]+" required />}</Field>
          <Field label={s.security}>
            {p => (
              <select {...p} value={v.security} onChange={set('security')}>
                <option value="tls">{s.tls}</option>
                <option value="starttls">{s.starttls}</option>
              </select>
            )}
          </Field>
          <Field label={s.username}>{p => <input {...p} value={v.username} onChange={set('username')} maxLength={320} autoComplete="off" required />}</Field>
          <Field label={s.password} hint={s.secretHint}>{p => <input {...p} type="password" value={v.password} onChange={set('password')} maxLength={1024} autoComplete="new-password" required />}</Field>
          <Field label={s.from} hint={s.fromHint}>{p => <input {...p} type="email" value={v.from} onChange={set('from')} maxLength={320} autoComplete="off" required />}</Field>
        </>
      ) : (
        <>
          <Field label={s.endpoint} hint={s.endpointHint}>{p => <input {...p} type="url" value={v.endpoint} onChange={set('endpoint')} maxLength={2048} autoComplete="off" required />}</Field>
          <Field label={s.signingKey} hint={s.signingKeyHint}>{p => <input {...p} type="password" value={v.signingKey} onChange={set('signingKey')} minLength={32} maxLength={1024} autoComplete="new-password" required />}</Field>
        </>
      )}
      <FormFoot>
        <button className="btn" type="submit" disabled={busy}>{s.connect}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </FormFoot>
      <Failure failure={failure} />
    </form>
  );
}

const NUMBERS = [
  ['sampling', 'matureAfter'], ['sampling', 'firstPerSegment'], ['sampling', 'firstPerAuthor'], ['sampling', 'everyNth'],
  ['circuit', 'windowHours'], ['circuit', 'minimumSample'], ['circuit', 'maxComplaints'], ['circuit', 'maxRefusals'], ['circuit', 'maxBounces'],
] as const;
type NumberKey = (typeof NUMBERS)[number][1];

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function startOf(policy: Policy | undefined) {
  const at = (group: 'sampling' | 'circuit', key: NumberKey) => (policy ? String((policy[group] as Record<string, number>)[key]) : '');
  return {
    timezone: policy?.timezone ?? browserZone(),
    accountDailyLimit: policy ? String(policy.accountDailyLimit) : '',
    domainDailyLimit: policy ? String(policy.domainDailyLimit) : '',
    autoSend: policy?.autoSend === true,
    numbers: Object.fromEntries(NUMBERS.map(([group, key]) => [key, at(group, key)])) as Record<NumberKey, string>,
  };
}

function policyOf(v: ReturnType<typeof startOf>): Policy {
  const n = (key: NumberKey) => Number(v.numbers[key]);
  return {
    timezone: v.timezone.trim(), accountDailyLimit: Number(v.accountDailyLimit), domainDailyLimit: Number(v.domainDailyLimit), autoSend: v.autoSend,
    sampling: { matureAfter: n('matureAfter'), firstPerSegment: n('firstPerSegment'), firstPerAuthor: n('firstPerAuthor'), everyNth: n('everyNth') },
    circuit: { windowHours: n('windowHours'), minimumSample: n('minimumSample'), maxComplaints: n('maxComplaints'), maxRefusals: n('maxRefusals'), maxBounces: n('maxBounces') },
  };
}

/* A channel's limits, its review and its stop, and whether it sends a direct message without a yes to each one. Every
   number is the person's own: none has a default. */
function PolicyForm({ channel, onDone, onCancel }: { channel: SetupChannel; onDone(): void; onCancel(): void }) {
  const t = useT();
  const s = t.outboundSetup;
  const [v, setV] = useState(() => startOf(channel.policy?.value));
  const { busy, failure, run } = useMove(onDone);
  const count = (key: NumberKey, min: number) => (
    <Field key={key} label={s.numbers[key]}>
      {p => <input {...p} type="number" min={min} step={1} value={v.numbers[key]} onChange={e => setV({ ...v, numbers: { ...v.numbers, [key]: e.target.value } })} required />}
    </Field>
  );
  function save(e: FormEvent) {
    e.preventDefault();
    void run(() => api.post(`/api/outbound/channels/${channel.id}/policies`, policyOf(v)));
  }
  return (
    <form className="repo-form" onSubmit={save} aria-label={s.policyTitle}>
      <Field label={s.accountDailyLimit} hint={s.accountDailyLimitHint}>{p => <input {...p} type="number" min={1} step={1} value={v.accountDailyLimit} onChange={e => setV({ ...v, accountDailyLimit: e.target.value })} required />}</Field>
      <Field label={s.domainDailyLimit} hint={s.domainDailyLimitHint}>{p => <input {...p} type="number" min={1} step={1} value={v.domainDailyLimit} onChange={e => setV({ ...v, domainDailyLimit: e.target.value })} required />}</Field>
      <Field label={s.timezone} hint={s.timezoneHint}>{p => <input {...p} value={v.timezone} onChange={e => setV({ ...v, timezone: e.target.value })} maxLength={64} required />}</Field>
      <label className="check-card">
        <TickBox checked={v.autoSend} onChange={e => setV({ ...v, autoSend: e.target.checked })} />
        <span>
          <b>{s.autoSend}</b>
          <small>{channel.audience === 'public' ? s.autoSendPublic : s.autoSendHint}</small>
        </span>
      </label>
      <fieldset className="field-group outbound-numbers">
        <legend>{s.reviewTitle}</legend>
        <div className="field-group-body">
          <p className="hint">{s.reviewHint}</p>
          {NUMBERS.slice(0, 4).map(([, key]) => count(key, key === 'everyNth' ? 1 : 0))}
        </div>
      </fieldset>
      <fieldset className="field-group outbound-numbers">
        <legend>{s.circuitTitle}</legend>
        <div className="field-group-body">
          <p className="hint">{s.circuitHint}</p>
          {NUMBERS.slice(4).map(([, key]) => count(key, key === 'windowHours' || key === 'minimumSample' ? 1 : 0))}
        </div>
      </fieldset>
      <FormFoot>
        <button className="btn" type="submit" disabled={busy}>{t.common.save}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </FormFoot>
      <Failure failure={failure} />
    </form>
  );
}

function policyLine(s: Messages['outboundSetup'], policy: SetupChannel['policy']): string {
  if (!policy) return s.noPolicy;
  return joined([s.limits(policy.value.accountDailyLimit, policy.value.domainDailyLimit), policy.value.autoSend ? s.autoSendOn : s.autoSendOff]);
}

function AccountLine({ account }: { account: SetupAccount }) {
  const s = useT().outboundSetup;
  return (
    <li className="outbound-entry">
      <span className="outbound-title">
        <b>{account.label}</b>
        <Status of={account.status}>{s.accountStatuses[account.status]}</Status>
      </span>
      <small>
        <bdi className="outbound-address">{account.senderDomain}</bdi>
        {`\u00a0· ${account.author ? s.writes(account.author.name) : s.nobodyWrites}`}
      </small>
    </li>
  );
}

type Open = 'account' | 'policy' | null;

/* One channel: what it goes by and who sends from it, and the moves of the people who run it. */
function ChannelCard({ channel, onChanged }: { channel: SetupChannel; onChanged(): void }) {
  const t = useT();
  const s = t.outboundSetup;
  const [open, setOpen] = useState<Open>(null);
  const { busy, failure, run } = useMove(onChanged);
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const working = channel.accounts.some(a => a.status === 'active');
  const stopOrReopen = channel.status === 'stopped' ? 'reopen' : 'stop';
  return (
    <div className="imp imp-taken">
      <header>
        <div className="outbound-title">
          <h3>{channel.name}</h3>
          <Status of={channel.status}>{t.outbound.channelStatuses[channel.status]}</Status>
        </div>
        <p className="outbound-meta">
          <span>{joined([s.adapters[channel.adapter], s.audiences[channel.audience]])}</span>
          <span>{policyLine(s, channel.policy)}</span>
        </p>
      </header>
      {channel.accounts.length ? <ul className="outbound-list">{channel.accounts.map(a => <AccountLine key={a.id} account={a} />)}</ul> : null}
      {!working && <p className="muted">{s.noAccount}</p>}
      {open === 'account' && <AccountForm channel={channel} onDone={done} onCancel={() => setOpen(null)} />}
      {open === 'policy' && <PolicyForm channel={channel} onDone={done} onCancel={() => setOpen(null)} />}
      {open === null && (
        <EntryActions>
          <button className="btn ghost" type="button" onClick={() => setOpen('account')}>{channel.adapter === 'smtp' ? s.connectMail : s.connectHook}</button>
          <button className="btn ghost" type="button" onClick={() => setOpen('policy')}>{channel.policy ? s.changePolicy : s.setPolicy}</button>
          <button className={stopOrReopen === 'stop' ? 'btn ghost danger' : 'btn ghost'} type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/outbound/channels/${channel.id}/${stopOrReopen}`, {}))}>{s[stopOrReopen]}</button>
        </EntryActions>
      )}
      <Failure failure={failure} />
    </div>
  );
}

/* A new way out for the department: it takes nothing until it has an account and a policy. */
function NewChannel({ departmentId, onChanged }: { departmentId: string; onChanged(): void }) {
  const t = useT();
  const s = t.outboundSetup;
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: '', adapter: 'smtp', purpose: '', audience: 'direct' });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const { busy, failure, run } = useMove(() => {
    setOpen(false);
    setV({ name: '', adapter: 'smtp', purpose: '', audience: 'direct' });
    onChanged();
  });
  if (!open) return <EntryActions><button className="btn ghost" type="button" onClick={() => setOpen(true)}>{s.newChannel}</button></EntryActions>;
  function save(e: FormEvent) {
    e.preventDefault();
    void run(() => api.post('/api/outbound/channels', { departmentId, name: v.name.trim(), adapter: v.adapter, purpose: v.purpose.trim(), audience: v.audience }));
  }
  return (
    <form className="repo-form" onSubmit={save} aria-label={s.newChannel}>
      <Field label={s.channelName}>{p => <input {...p} value={v.name} onChange={set('name')} maxLength={200} required />}</Field>
      <Field label={s.adapter}>
        {p => (
          <select {...p} value={v.adapter} onChange={set('adapter')}>
            <option value="smtp">{s.adapters.smtp}</option>
            <option value="webhook">{s.adapters.webhook}</option>
          </select>
        )}
      </Field>
      <Field label={s.purpose} hint={s.purposeHint}>{p => <input {...p} value={v.purpose} onChange={set('purpose')} maxLength={200} required />}</Field>
      <Field label={s.audience}>
        {p => (
          <select {...p} value={v.audience} onChange={set('audience')}>
            <option value="direct">{s.audiences.direct}</option>
            <option value="public">{s.audiences.public}</option>
          </select>
        )}
      </Field>
      <FormFoot>
        <button className="btn" type="submit" disabled={busy}>{s.create}</button>
        <button className="btn ghost" type="button" onClick={() => setOpen(false)}>{t.common.cancel}</button>
      </FormFoot>
      <Failure failure={failure} />
    </form>
  );
}

function byWhom(s: Messages['outboundSetup'], person: Named, agent: Named): string {
  if (!person) return '';
  return agent ? s.byVia(person.name, agent.name) : s.by(person.name);
}

function RevisionLine({ revision, onChanged }: { revision: Revision; onChanged(): void }) {
  const s = useT().outboundSetup;
  const { busy, failure, run } = useMove(onChanged);
  const author = revision.createdBy.name ?? '';
  const move = revision.status === 'proposed' ? 'publish' : revision.status === 'published' ? 'revoke' : null;
  return (
    <li className="outbound-entry">
      <span className="outbound-title">
        <b>{s.revision(revision.revision)}</b>
        <Status of={revision.status}>{s.statuses[revision.status]}</Status>
      </span>
      <span>{revision.summary}</span>
      <small>{joined([s.wrote(author), revision.status !== 'proposed' && byWhom(s, revision.publishedBy, revision.publishedVia)])}</small>
      {move && (
        <EntryActions>
          <button className={move === 'revoke' ? 'btn ghost danger' : 'btn ghost'} type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/outbound/catalog/${revision.id}/${move}`, {}))}>{s[move]}</button>
        </EntryActions>
      )}
      <Failure failure={failure} />
    </li>
  );
}

function CatalogEntry({ entry, onChanged }: { entry: Entry; onChanged(): void }) {
  const s = useT().outboundSetup;
  const kind = (s.kinds as Record<string, string>)[entry.kind] ?? entry.kind;
  const where = joined([entry.locale, entry.channel?.name]);
  return (
    <div className="imp imp-taken">
      <header>
        <h3>{`${kind}: ${entry.revisions[0]!.summary}`}</h3>
        <p className="outbound-meta">
          {where && <span>{where}</span>}
          <span>{entry.current === null ? s.notInUse : s.inUse(entry.current)}</span>
        </p>
      </header>
      <ul className="outbound-list outbound-entries">{entry.revisions.map(r => <RevisionLine key={r.id} revision={r} onChanged={onChanged} />)}</ul>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const s = useT().outboundSetup;
  const { language } = useLanguage();
  const at = new Date(entry.at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const what = s.log[entry.kind] ?? entry.kind;
  return (
    <li className="outbound-entry">
      <b>{what}</b>
      {entry.channel && <span>{entry.channel.name}</span>}
      <small>{joined([at, byWhom(s, entry.person, entry.agent)])}</small>
    </li>
  );
}

type Loaded = { runs: false } | { runs: true; channels: SetupChannel[]; entries: Entry[]; log: LogEntry[] };

/* The department's channels, and its catalog and log once the server says this person runs its messages. */
async function loaded(departmentId: string): Promise<Loaded> {
  const q = `department=${encodeURIComponent(departmentId)}`;
  const overview = await api.get<{ channels: SetupChannel[]; departments?: RunDepartment[] }>(`/api/outbound?${q}`);
  if (!overview.departments?.some(d => d.id === departmentId)) return { runs: false };
  const [catalog, log] = await Promise.all([api.get<{ entries: Entry[] }>(`/api/outbound/catalog?${q}`), api.get<{ entries: LogEntry[] }>(`/api/outbound/setup-log?${q}`)]);
  return { runs: true, channels: overview.channels.filter(c => c.departmentId === departmentId), entries: catalog.entries, log: log.entries };
}

function useDepartmentMessaging(departmentId: string) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const load = useCallback(() => {
    setFailure(null);
    loaded(departmentId).then(setData).catch(setFailure);
  }, [departmentId]);
  useEffect(load, [load]);
  return { data, failure, load };
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-part" aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {children}
    </section>
  );
}

/* What one department sends outside and how, for the people who run it; nothing for anyone else. title: the heading
   of its own section, where it stands alone. */
export function DepartmentMessaging({ departmentId, title }: { departmentId: string; title?: string }) {
  const t = useT();
  const id = useId();
  const { data, failure, load } = useDepartmentMessaging(departmentId);
  if (data?.runs === false) return null;
  const body = failure !== null ? <p className="alert" role="alert">{errorOf(t, failure)}</p> : !data ? <p className="muted" role="status">{t.common.loading}</p> : <SetupBody data={data} departmentId={departmentId} onChanged={load} />;
  if (!title) return body;
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {body}
    </section>
  );
}

function SetupBody({ data, departmentId, onChanged: load }: { data: Extract<Loaded, { runs: true }>; departmentId: string; onChanged(): void }) {
  const s = useT().outboundSetup;
  return (
    <div className="outbound-setup">
      <p className="muted">{s.intro}</p>
      <Part title={s.channelsTitle}>
        {data.channels.length === 0 && <p className="muted">{s.noChannels}</p>}
        <div className="imps">{data.channels.map(c => <ChannelCard key={c.id} channel={c} onChanged={load} />)}</div>
        <NewChannel departmentId={departmentId} onChanged={load} />
      </Part>
      <Part title={s.catalogTitle}>
        <p className="muted">{s.catalogIntro}</p>
        {data.entries.length === 0 ? <p className="muted">{s.catalogEmpty}</p> : <div className="imps">{data.entries.map(e => <CatalogEntry key={e.entryId} entry={e} onChanged={load} />)}</div>}
      </Part>
      <Part title={s.logTitle}>
        {data.log.length === 0 ? <p className="muted">{s.logEmpty}</p> : <ul className="outbound-list outbound-entries">{data.log.map(e => <LogLine key={e.id} entry={e} />)}</ul>}
      </Part>
    </div>
  );
}

/* In Settings: each department whose messages this person runs, with all of the above. */
export function RunDepartments({ departments }: { departments: readonly RunDepartment[] }) {
  const t = useT();
  return (
    <>
      {departments.map(d => (
        <section key={d.id} className="settings-part" aria-label={t.outboundSetup.title(deptLabel(t, d))}>
          <h3>{t.outboundSetup.title(deptLabel(t, d))}</h3>
          <DepartmentMessaging departmentId={d.id} />
        </section>
      ))}
    </>
  );
}
