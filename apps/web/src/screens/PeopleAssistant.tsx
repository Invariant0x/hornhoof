import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { ASSISTANT_PROGRAMS, type AssistantProgram, type Me, type PersonView } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';

type Owner = Pick<PersonView, 'id' | 'isOwner' | 'isCeoDelegate'>;

/* Whose assistant this person may set up, as the server's guard has it: their own, anyone's with the whole company, but the
   CEO's and the deputy's only the CEO's. */
const setsUpFor = (me: Me, owner: Owner): boolean =>
  owner.id === me.person.id || (me.person.scopeKind === 'company' && (me.person.isOwner || !(owner.isOwner || owner.isCeoDelegate)));

/* Whether this person looks after the assistant on its card: its program, its events address and its key. */
export function looksAfter(me: Me, assistant: PersonView, people: PersonView[]): boolean {
  const ownerId = assistant.assistant?.owner.id;
  const owner = people.find(p => p.id === ownerId);
  return Boolean(owner) && setsUpFor(me, owner!);
}

/* The tick that turns the invite form into the form of an assistant, and back. */
export function AgentTick({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const id = useId();
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} aria-labelledby={`${id}-name`} aria-describedby={`${id}-about`} />
      <span>
        <b id={`${id}-name`}>{t.people.isAssistant}</b>
        <small id={`${id}-about`}>{t.people.isAssistantAbout}</small>
      </span>
    </label>
  );
}

function ProgramAndAddress({ program, eventsUrl, onProgram, onEventsUrl }: { program: AssistantProgram; eventsUrl: string; onProgram: (p: AssistantProgram) => void; onEventsUrl: (url: string) => void }) {
  const t = useT();
  /* OpenClaw and Hermes take a wake at their own webhook, whose address the person makes from the computer's. */
  const where = program === 'openclaw' ? t.people.eventsUrlOpenclaw : program === 'hermes' ? t.people.eventsUrlHermes : '';
  return <>
    <Field label={t.people.program}>
      {p => <select {...p} value={program} onChange={e => onProgram(e.target.value as AssistantProgram)}>{ASSISTANT_PROGRAMS.map(k => <option key={k} value={k}>{t.people.programs[k]}</option>)}</select>}
    </Field>
    <Field label={t.people.eventsUrl} hint={where ? `${t.people.eventsUrlHint} ${where}` : t.people.eventsUrlHint}>
      {p => <input {...p} type="url" value={eventsUrl} onChange={e => onEventsUrl(e.target.value)} maxLength={500} placeholder="https://" autoComplete="off" spellCheck={false} />}
    </Field>
  </>;
}

/* own: the person adds their own assistant, so there is nobody to choose. tick: the switch back to inviting a person. */
export function NewAssistant({ me, people, own, tick, initial, onMade, onClose }: { me: Me; people: PersonView[]; own: boolean; tick?: ReactNode; initial: { name: string; title: string }; onMade: (person: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [title, setTitle] = useState(initial.title);
  const [owner, setOwner] = useState(me.person.id);
  const [program, setProgram] = useState<AssistantProgram>('avaclone');
  const [eventsUrl, setEventsUrl] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const owners = people.filter(p => p.status === 'active' && !p.assistant && setsUpFor(me, p));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const body = { name: name.trim(), title: title.trim(), owner: own ? me.person.id : owner, program, eventsUrl: eventsUrl.trim() || null };
      onMade((await api.post<{ person: PersonView }>('/api/people/assistants', body)).person);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>{t.people.newAssistant}</h2>
      <form onSubmit={e => void submit(e)} className="panel-form">
        {tick}
        <Field label={t.common.name}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}</Field>
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} />}</Field>
        {!own && (
          <Field label={t.people.assistantOwner}>
            {p => <select {...p} value={owner} onChange={e => setOwner(e.target.value)}>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
          </Field>
        )}
        <ProgramAndAddress program={program} eventsUrl={eventsUrl} onProgram={setProgram} onEventsUrl={setEventsUrl} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || !name.trim()}>{t.people.addAssistant}</button>
        </div>
      </form>
    </Edge>
  );
}

function Secret({ label, value, copy }: { label: string; value: string; copy: string }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="command">
        <code>{value}</code>
        <CopyButton text={value} label={copy} />
      </div>
    </div>
  );
}

/* The settings that connect the program, as they go into its own file. */
type Setup = { file: string; text: string };

/* The settings for the program, with a Copy that takes their lines whole. */
function SetupLines({ program, setup }: { program: AssistantProgram; setup: Setup }) {
  const t = useT();
  return (
    <div className="field">
      <span className="label">{t.people.setupFor(t.people.programs[program])}</span>
      <span className="hint">{t.people.setupWhere(setup.file)}</span>
      <div className="command">
        <pre><code>{setup.text}</code></pre>
        <CopyButton text={setup.text} label={t.people.copySetup} />
      </div>
    </div>
  );
}

/* address: the company's address as its invite links have it. setup: the settings for OpenClaw or Hermes, or null for a
   program that takes the address and the key in its own way. */
type Made = { key: string; signingSecret: string; address: string; setup?: Setup | null; person: PersonView };

/* The key and the signing secret: made, made again or taken away here, and shown once, right after they are made. */
function KeySection({ person, onChanged }: { person: PersonView; onChanged: (person: PersonView) => void }) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const [shown, setShown] = useState<Made | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const made = person.assistant?.key;

  async function run(action: () => Promise<PersonView>) {
    setBusy(true);
    setFailure(null);
    try {
      onChanged(await action());
    } catch (err) {
      setFailure(err);
    }
    setBusy(false);
  }
  const create = () => run(async () => {
    const res = await api.post<Made>(`/api/people/${person.id}/key`);
    setShown(res);
    return res.person;
  });
  const revoke = () => run(async () => (await api.del<{ person: PersonView }>(`/api/people/${person.id}/key`)).person);

  return (
    <section className="assistant-key" aria-labelledby={`${id}-key`}>
      <h3 id={`${id}-key`}>{t.people.key}</h3>
      <p className="muted">{t.people.keyAbout}</p>
      {shown ? <>
        <p>{t.people.keyShownOnce}</p>
        <Secret label={t.people.key} value={shown.key} copy={t.people.copyKey} />
        <Secret label={t.people.signingSecret} value={shown.signingSecret} copy={t.people.copySecret} />
        {shown.setup && <SetupLines program={shown.person.assistant?.program ?? 'other'} setup={shown.setup} />}
        <div className="actions">
          {/* The address and the key in one text, which the person sends their assistant as it is; never the signing secret. */}
          <CopyButton text={t.people.forAssistant(shown.address, shown.key)} label={t.people.copyForAssistant} className="btn ghost" />
          <button className="btn" type="button" onClick={() => setShown(null)}>{t.people.keySaved}</button>
        </div>
      </> : <>
        <p>{made ? t.people.keyMade(new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(made.createdAt))) : t.people.noKey}</p>
        <div className="actions">
          {made ? <>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void create()}>{t.people.replaceKey}</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void revoke()}>{t.people.revokeKey}</button>
          </> : <button className="btn" type="button" disabled={busy} onClick={() => void create()}>{t.people.createKey}</button>}
        </div>
      </>}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* What Save sends on the person's own row: only for someone who manages people, and only when the name or title changed. */
function personChanges(person: PersonView, names: { manages: boolean; rename: boolean }, name: string, title: string) {
  if (!names.manages) return null;
  const changes = { ...(names.rename && name.trim() !== person.name ? { name: name.trim() } : {}), title: title.trim() };
  return 'name' in changes || changes.title !== person.title ? changes : null;
}

/* An assistant's card: whom it acts for, its name and title for someone who manages people, its program, its events
   address and its key. onChanged: the key changed, and the card stays open. */
export function AssistantCard({ person, manages, rename, onChanged, onSaved, onClose }: { person: PersonView; manages: boolean; rename: boolean; onChanged: (p: PersonView) => void; onSaved: (p: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(person.name);
  const [title, setTitle] = useState(person.title);
  const [program, setProgram] = useState<AssistantProgram>(person.assistant?.program ?? 'avaclone');
  const [eventsUrl, setEventsUrl] = useState(person.assistant?.eventsUrl ?? '');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const changes = personChanges(person, { manages, rename }, name, title);
      if (changes) onChanged((await api.patch<{ person: PersonView }>(`/api/people/${person.id}`, changes)).person);
      onSaved((await api.patch<{ person: PersonView }>(`/api/people/${person.id}/assistant`, { program, eventsUrl: eventsUrl.trim() || null })).person);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>{t.people.editHeading(person.name)}</h2>
      <p className="muted">{t.people.actsFor(person.assistant?.owner.name ?? '')}</p>
      <form onSubmit={e => void submit(e)} className="panel-form">
        {manages && rename && <Field label={t.common.name}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} required />}</Field>}
        {manages && <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} />}</Field>}
        <ProgramAndAddress program={program} eventsUrl={eventsUrl} onProgram={setProgram} onEventsUrl={setEventsUrl} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || (manages && rename && !name.trim())}>{t.common.save}</button>
        </div>
      </form>
      <KeySection person={person} onChanged={onChanged} />
    </Edge>
  );
}
