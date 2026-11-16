import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import type { Messages } from '../i18n/en';
import { joined, RevisionView, whenOf } from './CatalogRevision';
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
  value: { kind?: string };
  createdAt: string;
  createdBy: { kind: 'person' | 'agent'; name: string | null };
  publishedBy: Named;
  publishedVia: Named;
};
type Entry = { entryId: string; kind: string; locale: string | null; channel: Named; current: number | null; revisions: Revision[] };
type LogEntry = { id: string; kind: keyof Messages['outboundSetup']['log']; channel: Named; detail: Record<string, unknown>; person: Named; agent: Named; at: string };

export type RunDepartment = { id: string; name: string | null; templateKey: keyof Messages['templates'] | null };

const reasonOf = (err: unknown): string | undefined => (err instanceof ApiFailure ? err.reason : undefined);
const errorOf = (t: Messages, err: unknown): string => (reasonOf(err) === 'outbound_invalid' ? t.outboundSetup.invalid : errorText(t, err));

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
      <fieldset className="outbound-numbers">
        <legend>{s.reviewTitle}</legend>
        <div className="outbound-numbers-body">
          <p className="hint">{s.reviewHint}</p>
          {NUMBERS.slice(0, 4).map(([, key]) => count(key, key === 'everyNth' ? 1 : 0))}
        </div>
      </fieldset>
      <fieldset className="outbound-numbers">
        <legend>{s.circuitTitle}</legend>
        <div className="outbound-numbers-body">
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

type Open = 'account' | 'policy' | 'contact' | null;

/* One channel: what it goes by and who sends from it, and the moves of the people who run it. */
function ChannelCard({ channel, onChanged }: { channel: SetupChannel; onChanged(): void }) {
  const t = useT();
  const s = t.outboundSetup;
  const [open, setOpen] = useState<Open>(null);
  const [added, setAdded] = useState<string | null>(null);
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const working = channel.accounts.some(a => a.status === 'active');
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
      {open === 'contact' && <ContactForm channel={channel} onDone={said => { setOpen(null); setAdded(said); }} onCancel={() => setOpen(null)} />}
      {added && <p className="muted outbound-added" role="status">{added}</p>}
      {open === null && <ChannelActions channel={channel} onOpen={form => { setAdded(null); setOpen(form); }} onChanged={onChanged} />}
    </div>
  );
}

/* What a channel's runner does with it: its account, its limits, an address for a channel to contacts, and its stop. */
function ChannelActions({ channel, onOpen, onChanged }: { channel: SetupChannel; onOpen(form: Exclude<Open, null>): void; onChanged(): void }) {
  const s = useT().outboundSetup;
  const { busy, failure, run } = useMove(onChanged);
  const stopOrReopen = channel.status === 'stopped' ? 'reopen' : 'stop';
  return (
    <>
      <EntryActions>
        <button className="btn ghost" type="button" onClick={() => onOpen('account')}>{channel.adapter === 'smtp' ? s.connectMail : s.connectHook}</button>
        <button className="btn ghost" type="button" onClick={() => onOpen('policy')}>{channel.policy ? s.changePolicy : s.setPolicy}</button>
        {channel.audience === 'direct' && <button className="btn ghost" type="button" onClick={() => onOpen('contact')}>{s.contact.add}</button>}
        <button className={stopOrReopen === 'stop' ? 'btn ghost danger' : 'btn ghost'} type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/outbound/channels/${channel.id}/${stopOrReopen}`, {}))}>{s[stopOrReopen]}</button>
      </EntryActions>
      <Failure failure={failure} />
    </>
  );
}

type ContactField = 'address' | 'source' | 'evidence' | 'agreed';
type ContactDraft = Record<Exclude<ContactField, 'agreed'>, string> & { agreed: boolean };
type ContactProblems = Partial<Record<ContactField, string>>;
type ContactWords = Messages['outboundSetup']['contact'];
const CONTACT_FIELDS: readonly ContactField[] = ['address', 'source', 'evidence', 'agreed'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* What is wrong with the address itself, before it goes: the server reads it again by its own rule. */
function addressProblem(c: ContactWords, email: boolean, address: string): string | undefined {
  if (!address) return c.addressMissing;
  if (email ? EMAIL.test(address) : !/\s/.test(address)) return undefined;
  return email ? c.notEmail : c.notHandle;
}

function contactProblems(c: ContactWords, email: boolean, v: ContactDraft): ContactProblems {
  const found: ContactProblems = { address: addressProblem(c, email, v.address.trim()) };
  if (!v.source.trim()) found.source = c.sourceMissing;
  if (!v.evidence.trim()) found.evidence = c.evidenceMissing;
  if (!v.agreed) found.agreed = c.agreedMissing;
  return found;
}

/* The server's refusal, where the form shows it: an address it does not take at its field, a person who said no for
   good, or anything else, above the buttons. */
function contactRefusal(t: Messages, email: boolean, err: unknown): { problems: ContactProblems; alert: string | null } {
  const c = t.outboundSetup.contact;
  if (err instanceof ApiFailure && err.reason === 'outbound_invalid') return { problems: { address: email ? c.notEmail : c.notHandle }, alert: null };
  const codes = err instanceof ApiFailure ? err.details?.['reasonCodes'] : null;
  return { problems: {}, alert: Array.isArray(codes) && codes.includes('contact_suppressed') ? c.suppressed : errorOf(t, err) };
}

/* The address form's state and its sending: each problem at its field with the focus on the first of them, the
   server's refusal where it belongs, and what was added once it was. */
function useContactForm(channel: SetupChannel, onDone: (said: string) => void) {
  const t = useT();
  const c = t.outboundSetup.contact;
  const email = channel.adapter === 'smtp';
  const [v, setV] = useState<ContactDraft>({ address: '', source: '', evidence: '', agreed: false });
  const [problems, setProblems] = useState<ContactProblems>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = { address: useRef<HTMLInputElement>(null), source: useRef<HTMLInputElement>(null), evidence: useRef<HTMLTextAreaElement>(null), agreed: useRef<HTMLInputElement>(null) };
  /* The problems at their fields, and the focus on the first of them; true when there is one. */
  const show = (found: ContactProblems): boolean => {
    setProblems(found);
    const first = CONTACT_FIELDS.find(f => found[f]);
    if (first) refs[first].current?.focus();
    return first !== undefined;
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    if (show(contactProblems(c, email, v))) return;
    const address = v.address.trim();
    setBusy(true);
    try {
      const said = await api.post<{ permissionId: string | null }>('/api/outbound/contacts', { channelId: channel.id, kind: email ? 'email' : 'direct', address, source: v.source.trim(), evidence: v.evidence.trim() });
      onDone(said.permissionId ? c.added(address) : c.known(address));
    } catch (err) {
      const refused = contactRefusal(t, email, err);
      show(refused.problems);
      setAlert(refused.alert);
    } finally {
      setBusy(false);
    }
  }
  const address = email ? { label: c.email, type: 'email', inputMode: 'email' as const } : { label: c.handle, type: 'text', inputMode: undefined };
  return { v, setV, problems, alert, busy, refs, save, address };
}

/* An address that agreed to the channel's purpose, a test address of the team among them. It goes through the server's
   own consent: the server keeps where they agreed and a fingerprint of the proof, under the channel's purpose, and looks
   for that before every message. The tick is the word of the person adding it that the consent was given. */
function ContactForm({ channel, onDone, onCancel }: { channel: SetupChannel; onDone(said: string): void; onCancel(): void }) {
  const t = useT();
  const c = t.outboundSetup.contact;
  const id = useId();
  const { v, setV, problems, alert, busy, refs, save, address } = useContactForm(channel, onDone);
  const set = (k: Exclude<ContactField, 'agreed'>) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const agreedNote = problems.agreed && `${id}-agreed`;
  return (
    <form className="repo-form" noValidate onSubmit={e => void save(e)} aria-label={c.add}>
      <Field label={address.label} hint={c.addressHint} problem={problems.address}>
        {p => <input {...p} ref={refs.address} type={address.type} inputMode={address.inputMode} dir="auto" value={v.address} onChange={set('address')} maxLength={320} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label={c.source} hint={c.sourceHint} problem={problems.source}>{p => <input {...p} ref={refs.source} value={v.source} onChange={set('source')} maxLength={200} />}</Field>
      <Field label={c.evidence} hint={c.evidenceHint} problem={problems.evidence}>{p => <textarea {...p} ref={refs.evidence} rows={3} value={v.evidence} onChange={set('evidence')} maxLength={2000} />}</Field>
      <label className="check-card">
        <TickBox ref={refs.agreed} checked={v.agreed} onChange={e => setV({ ...v, agreed: e.target.checked })} aria-invalid={agreedNote ? true : undefined} aria-describedby={agreedNote || undefined} />
        <span>
          <b>{c.agreed}</b>
          <small>{c.purpose(channel.purpose)}</small>
        </span>
      </label>
      {agreedNote && <span id={agreedNote} className="bad">{problems.agreed}</span>}
      <FormFoot>
        <button className="btn" type="submit" disabled={busy}>{c.submit}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </FormFoot>
      {alert && <p className="alert" role="alert">{alert}</p>}
    </form>
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

/* A revision with its view, the newest one open at once: what is published or taken back is the revision shown, as its
   entry stood when it was shown, so a newer version since makes the server refuse and the catalog is read again. */
function RevisionLine({ entry, revision, onChanged }: { entry: Entry; revision: Revision; onChanged(): void }) {
  const s = useT().outboundSetup;
  const { busy, failure, run } = useMove(onChanged);
  const newest = entry.revisions[0]!.revision;
  const [open, setOpen] = useState(revision.revision === newest);
  const viewId = useId();
  const author = revision.createdBy.name ?? '';
  const move = revision.status === 'proposed' ? 'publish' : revision.status === 'published' ? 'revoke' : null;
  const act = (to: 'publish' | 'revoke') =>
    run(async () => {
      try {
        await api.post(`/api/outbound/catalog/${revision.id}/${to}`, { revision: revision.revision, newest });
      } catch (err) {
        if (reasonOf(err) === 'outbound_changed') onChanged();
        throw err;
      }
    });
  return (
    <li className="outbound-entry">
      <span className="outbound-title">
        <b>{s.revision(revision.revision)}</b>
        <Status of={revision.status}>{s.statuses[revision.status]}</Status>
      </span>
      <span>{revision.summary}</span>
      <small>{joined([s.wrote(author), revision.status !== 'proposed' && byWhom(s, revision.publishedBy, revision.publishedVia)])}</small>
      <EntryActions>
        <button className="btn ghost" type="button" aria-expanded={open} aria-controls={viewId} onClick={() => setOpen(!open)}>{open ? s.hide(revision.revision) : s.show(revision.revision)}</button>
      </EntryActions>
      {open && (
        <RevisionView id={viewId} entry={entry} revision={revision}>
          {move && (
            <EntryActions>
              <button className={move === 'revoke' ? 'btn ghost danger' : 'btn'} type="button" disabled={busy} onClick={() => void act(move)}>{s[move]}</button>
            </EntryActions>
          )}
        </RevisionView>
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
      <ul className="outbound-list outbound-entries">{entry.revisions.map(r => <RevisionLine key={r.id} entry={entry} revision={r} onChanged={onChanged} />)}</ul>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const s = useT().outboundSetup;
  const { language } = useLanguage();
  const at = whenOf(language, entry.at);
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

/* Whether the server lets this person run the department's messages, asked only of those who may: false until it says
   so, and when it cannot be asked. */
export function useRunsMessaging(departmentId: string, ask: boolean): boolean {
  const [runs, setRuns] = useState(false);
  useEffect(() => {
    setRuns(false);
    if (!ask) return;
    let live = true;
    const said = (yes: boolean) => { if (live) setRuns(yes); };
    api.get<{ departments?: RunDepartment[] }>(`/api/outbound?department=${encodeURIComponent(departmentId)}`).then(o => said(!!o.departments?.some(d => d.id === departmentId)), () => said(false));
    return () => { live = false; };
  }, [departmentId, ask]);
  return runs;
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

/* What one department sends outside and how, for the people who run it; nothing for anyone else. Its heading is the
   place's own: the department's panel, or a department's part of Settings. */
export function DepartmentMessaging({ departmentId }: { departmentId: string }) {
  const t = useT();
  const { data, failure, load } = useDepartmentMessaging(departmentId);
  if (data?.runs === false) return null;
  if (failure !== null) return <p className="alert" role="alert">{errorOf(t, failure)}</p>;
  return data ? <SetupBody data={data} departmentId={departmentId} onChanged={load} /> : <p className="muted" role="status">{t.common.loading}</p>;
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
