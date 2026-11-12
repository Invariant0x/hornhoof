import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { ASSISTANT_PROGRAMS, type AssistantProgram, type Me, type PersonView } from '../types';
import { BusyLabel } from '../ui/BusyLabel';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';
import { AgentIcon, EditIcon, KeyIcon, PersonIcon } from '../ui/icons';

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

/* Who joins: a person or a personal AI assistant, two cards with their icons, one of them chosen. Choosing turns the invite
   form into the form of an assistant, and back. The radios are native, so the arrow keys move between them. */
export function KindSwitch({ agent, onChange }: { agent: boolean; onChange: (agent: boolean) => void }) {
  const t = useT();
  const id = useId();
  const kinds = [
    { agent: false, key: 'person', icon: <PersonIcon />, name: t.people.kindPerson, about: t.people.kindPersonHint },
    { agent: true, key: 'agent', icon: <AgentIcon />, name: t.people.kindAssistant, about: t.people.kindAssistantHint },
  ];
  return (
    <div className="kind-switch" role="radiogroup" aria-label={t.people.kind}>
      {kinds.map(kind => {
        const on = kind.agent === agent;
        return (
          <label key={kind.key} className={on ? 'kind-card on' : 'kind-card'}>
            <input className="sr" type="radio" name={id} checked={on} onChange={() => onChange(kind.agent)} aria-labelledby={`${id}-${kind.key}`} aria-describedby={`${id}-${kind.key}-about`} />
            {kind.icon}
            <span>
              <b id={`${id}-${kind.key}`}>{kind.name}</b>
              <small id={`${id}-${kind.key}-about`}>{kind.about}</small>
            </span>
          </label>
        );
      })}
    </div>
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

type Draft = { name: string; title: string; owner: string; program: AssistantProgram; eventsUrl: string };

/* What Create sends: the person themself as the owner when they add their own, and no events address for an empty one. */
const assistantBody = (me: Me, own: boolean, draft: Draft) =>
  ({ name: draft.name.trim(), title: draft.title.trim(), owner: own ? me.person.id : draft.owner, program: draft.program, eventsUrl: draft.eventsUrl.trim() || null });

/* own: the person adds their own assistant, so there is nobody to choose. kind: the switch back to inviting a person, under
   the heading the invite form has, so switching moves nothing above it. */
export function NewAssistant({ me, people, own, heading, kind, initial, onMade, onClose }: { me: Me; people: PersonView[]; own: boolean; heading: string; kind?: ReactNode; initial: { name: string; title: string }; onMade: (person: PersonView) => void; onClose: () => void }) {
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
      onMade((await api.post<{ person: PersonView }>('/api/people/assistants', assistantBody(me, own, { name, title, owner, program, eventsUrl }))).person);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title">{kind ? <PersonIcon /> : <AgentIcon />}{heading}</h2>
      </div>
      <form onSubmit={e => void submit(e)} className="form-grid">
        {kind}
        <Field label={t.people.assistantName}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}</Field>
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} />}</Field>
        {!own && (
          <Field label={t.people.assistantOwner} hint={t.people.assistantOwnerHint}>
            {p => <select {...p} value={owner} onChange={e => setOwner(e.target.value)}>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
          </Field>
        )}
        <ProgramAndAddress program={program} eventsUrl={eventsUrl} onProgram={setProgram} onEventsUrl={setEventsUrl} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || !name.trim()}>
            <BusyLabel busy={busy} idle={t.people.createAssistant} working={t.common.creating} />
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </form>
    </Edge>
  );
}

/* One value shown once: its name, the value, and its Copy under it at the end of the line. */
function Secret({ label, value, copy }: { label: string; value: string; copy: string }) {
  const id = useId();
  return (
    <div className="secret" role="group" aria-labelledby={id}>
      <span className="secret-title" id={id}>{label}</span>
      <code className="secret-code">{value}</code>
      <div className="form-foot">
        <CopyButton text={value} label={copy} className="btn" />
      </div>
    </div>
  );
}

/* The settings that connect the program, as they go into its own file. */
type Setup = { file: string; text: string };

/* The settings for the program, shown once like the key: where they go, their lines whole, and a Copy that takes them all. */
function SetupLines({ program, setup }: { program: AssistantProgram; setup: Setup }) {
  const t = useT();
  const id = useId();
  return (
    <div className="secret" role="group" aria-labelledby={id}>
      <span className="secret-title" id={id}>{t.people.setupFor(t.people.programs[program])}</span>
      <p className="muted">{t.people.setupWhere(setup.file)}</p>
      <pre className="secret-code"><code>{setup.text}</code></pre>
      <div className="form-foot">
        <CopyButton text={setup.text} label={t.people.copySetup} className="btn" />
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
        <div className="secret">
          <p className="secret-title">{t.people.keyIssued}</p>
          <p className="muted">{t.people.keyShownOnce}</p>
        </div>
        <Secret label={t.people.key} value={shown.key} copy={t.people.copyKey} />
        <Secret label={t.people.signingSecret} value={shown.signingSecret} copy={t.people.copySecret} />
        {shown.setup && <SetupLines program={shown.person.assistant?.program ?? 'other'} setup={shown.setup} />}
        <div className="form-foot">
          {/* The address and the key in one text, which the person sends their assistant as it is; never the signing secret. */}
          <CopyButton text={t.people.forAssistant(shown.address, shown.key)} label={t.people.copyForAssistant} className="btn" />
          <button className="btn ghost" type="button" onClick={() => setShown(null)}>{t.people.hideKey}</button>
        </div>
      </> : <>
        <p className="key-line"><KeyIcon />{made ? t.people.keyMade(new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(made.createdAt))) : t.people.noKey}</p>
        <div className="entry-actions">
          {made ? <>
            <button className="act" type="button" disabled={busy} onClick={() => void create()}>{t.people.replaceKey}</button>
            <button className="act danger" type="button" disabled={busy} onClick={() => void revoke()}>{t.people.revokeKey}</button>
          </> : <button className="btn" type="button" disabled={busy} onClick={() => void create()}>{t.people.issueKey}</button>}
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
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title"><EditIcon />{t.people.editHeading(person.name)}</h2>
        <p className="muted">{t.people.actsFor(person.assistant?.owner.name ?? '')}</p>
      </div>
      <form onSubmit={e => void submit(e)} className="form-grid">
        {manages && rename && <Field label={t.people.assistantName}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} required />}</Field>}
        {manages && <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} />}</Field>}
        <ProgramAndAddress program={program} eventsUrl={eventsUrl} onProgram={setProgram} onEventsUrl={setEventsUrl} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || (manages && rename && !name.trim())}>
            <BusyLabel busy={busy} idle={t.common.save} working={t.common.saving} />
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </form>
      <KeySection person={person} onChanged={onChanged} />
    </Edge>
  );
}
