import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { fitTable } from '../ui/fit-table';
import type { AccessInput, Me, Org, PersonView } from '../types';
import { accessEmpty, accessInput, AccessPicker, accessText } from '../ui/AccessPicker';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { LoadFailure } from '../ui/LoadFailure';
import { doneOf, Hold, Idle, LoadLine, useHeldRows, useLoad, type Load } from '../ui/Loading';
import { latestAnswers, useStream } from '../live';
import { Field } from '../ui/Field';
import { NOT_A_LOGIN } from '../ui/SecretInput';
import { BusyLabel } from '../ui/BusyLabel';
import { AgentIcon, DeputyIcon, EditIcon, PersonIcon } from '../ui/icons';
import { AssistantCard, KindSwitch, looksAfter, NewAssistant } from './PeopleAssistant';
import { RouteUnavailable, unavailableFailure, type CardRoute } from './RouteUnavailable';
import { guardedResizeObserver } from '../guard';
import { useDialogClose } from '../ui/use-dialog-close';
import { useSteady } from './Feedback';

/* assistant: a person without the whole company adds their own assistant. */
type Panel =
  | { kind: 'invite' }
  | { kind: 'assistant' }
  | { kind: 'link'; name: string; url: string }
  | { kind: 'edit'; person: PersonView; titleOnly: boolean; deputy: boolean }
  | { kind: 'delete'; person: PersonView }
  | null;

/* The link, shown once: its note, the link right under it, and Copy and Done under the link. */
function InviteLink({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const t = useT();
  return (
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title"><PersonIcon />{t.people.linkFor(name)}</h2>
      </div>
      <div className="secret">
        <p className="muted">{t.people.linkNote}</p>
        <code className="secret-code">{url}</code>
        <div className="form-foot">
          <CopyButton text={url} className="btn" />
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </div>
      </div>
    </Edge>
  );
}

/* The CEO deletes a person or an assistant for good: one question that says what ends with them and that it cannot be
   undone. The focus goes to it, and Escape leaves the person as they are. */
function DeleteAsk({ person, onYes, onClose }: { person: PersonView; onYes: () => Promise<void>; onClose: () => void }) {
  const t = useT();
  const box = useDialogClose(useSteady(onClose));
  const title = useId();
  const note = useId();
  const [busy, setBusy] = useState(false);
  const yes = async () => {
    setBusy(true);
    try {
      await onYes();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Edge className="panel form-card" cut={12}>
      <div ref={box} role="alertdialog" aria-labelledby={title} aria-describedby={note} tabIndex={-1}>
        <div className="form-head">
          <h2 className="form-title" id={title}>{person.assistant ? <AgentIcon /> : <PersonIcon />}{t.people.deleteAsk(person.name)}</h2>
        </div>
        <p className="muted" id={note}>{person.assistant ? t.people.deleteAssistantNote : t.people.deleteNote}</p>
        <div className="form-foot">
          <button className="btn" type="button" disabled={busy} onClick={() => void yes()}>{t.people.yesDelete}</button>
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </div>
    </Edge>
  );
}

type Invite = { org: Org | null; me: Me; people: PersonView[]; onSent: (name: string, url: string) => void; onAssistant: (person: PersonView) => void; onClose: () => void };

/* Invites a person, or, with the switch on the assistant, adds an agent that acts for one, keeping the name and title typed. */
function InviteForm({ org, me, people, onSent, onAssistant, onClose }: Invite) {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [access, setAccess] = useState<AccessInput>({ whole: true });
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState(false);
  const [switched, setSwitched] = useState(false);
  const switchTo = (next: boolean) => {
    setSwitched(true);
    setAgent(next);
  };
  if (agent) return <NewAssistant me={me} people={people} own={false} heading={t.people.addTitle} kind={<KindSwitch agent switched={switched} onChange={switchTo} />} initial={{ name, title }} onMade={onAssistant} onClose={onClose} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (accessEmpty(access)) return;
    setBusy(true);
    setFailure('');
    try {
      const res = await api.post<{ person: PersonView; inviteUrl: string }>('/api/people/invite', {
        name: name.trim(),
        email: email.trim(),
        title: title.trim(),
        access,
      });
      onSent(res.person.name, res.inviteUrl);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title"><PersonIcon />{t.people.addTitle}</h2>
      </div>
      <form onSubmit={e => void submit(e)} className="form-grid">
        <KindSwitch agent={false} switched={switched} onChange={switchTo} />
        <Field label={t.common.name} hint={t.people.nameHint}>{p => <input {...p} {...NOT_A_LOGIN} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoComplete="off" autoFocus required />}</Field>
        <Field label={t.common.email} hint={t.people.emailHint}>{p => <input {...p} {...NOT_A_LOGIN} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" required />}</Field>
        <Field label={t.common.title}>{p => <input {...p} {...NOT_A_LOGIN} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder={t.people.titlePlaceholder} autoComplete="off" />}</Field>
        <AccessPicker org={org} value={access} onChange={setAccess} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || !name.trim() || !email.trim() || accessEmpty(access)}>
            <BusyLabel busy={busy} idle={t.people.createInvite} working={t.common.creating} />
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </form>
    </Edge>
  );
}

/* What the window holds: the access, the deputy, and the access from before the deputy was switched on here. */
type Choice = { access: AccessInput; deputy: boolean; before: AccessInput | null };

/* How the window holds the deputy and the access together. A deputy sees the whole company, as the server requires: making
   someone the deputy gives them the whole company, switching it off again gives back the access they had, and a narrower
   access takes the deputy off. */
const deputyRule = {
  switched: (c: Choice, on: boolean): Choice => (on ? { access: { whole: true }, deputy: true, before: c.access } : { access: c.before ?? c.access, deputy: false, before: null }),
  accessed: (c: Choice, access: AccessInput): Choice => ({ ...c, access, deputy: c.deputy && 'whole' in access }),
};

/* Whether Save sends the deputy call: only when the switch was changed here, which only the CEO sees, and only as far as
   the server has not got there itself, as it takes the deputy off a narrower access, or someone did in another window. */
const deputyCall = (wanted: boolean, opened: PersonView, saved: PersonView): boolean =>
  wanted !== Boolean(opened.isCeoDelegate) && wanted !== Boolean(saved.isCeoDelegate);

/* The CEO's switch for the deputy, right after the access, in the row of the authority, with what it gives under it. */
function DeputySwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <span className="label">{t.people.authority}</span>
      <div className="field-control">
        <label className="check-card">
          <input type="checkbox" role="switch" checked={on} onChange={e => onChange(e.target.checked)} aria-labelledby={`${id}-name`} aria-describedby={`${id}-about`} />
          <span>
            <b id={`${id}-name`}>{t.people.ceoDelegate}</b>
            <small id={`${id}-about`}>{t.people.deputyAbout}</small>
          </span>
        </label>
      </div>
    </div>
  );
}

/* rename: the server lets this person change the name here. titleOnly: access is not theirs to change here. telegram: nor
   is the person's Telegram, which is their own and, but for the CEO's and the deputy's, theirs who manage them. */
type EditRights = { rename: boolean; titleOnly: boolean; telegram: boolean };
type EditDraft = { name: string; title: string; access: AccessInput; telegram: string };

/* The person's Telegram as the field shows it: the username, or the account's number when that is all there is. */
const telegramOf = (person: PersonView): string => (person.telegram?.username ? `@${person.telegram.username}` : person.telegram?.id != null ? String(person.telegram.id) : '');

/* What Save sends: the name and the Telegram only when the window shows them and they changed, so an old window takes back
   nobody's new name, and a number a bot learned stays. */
function changesOf(person: PersonView, { rename, titleOnly, telegram: tg }: EditRights, draft: EditDraft) {
  const name = draft.name.trim();
  const telegram = draft.telegram.trim();
  return {
    ...(rename && name !== person.name ? { name } : {}),
    title: draft.title.trim(),
    ...(titleOnly ? {} : { access: draft.access }),
    ...(tg && telegram !== telegramOf(person) ? { telegram } : {}),
  };
}

const fillable = ({ rename, titleOnly }: EditRights, draft: EditDraft): boolean => (!rename || draft.name.trim() !== '') && (titleOnly || !accessEmpty(draft.access));

/* The name, when the form shows it, above the title. */
function NameAndTitle({ rename, name, title, onName, onTitle }: { rename: boolean; name: string; title: string; onName: (name: string) => void; onTitle: (title: string) => void }) {
  const t = useT();
  return <>
    {rename && <Field label={t.common.name}>{p => <input {...p} value={name} onChange={e => onName(e.target.value)} maxLength={80} autoFocus required />}</Field>}
    <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => onTitle(e.target.value)} maxLength={80} autoFocus={!rename} />}</Field>
  </>;
}

/* Your own row and the owner's take no access. deputy: the CEO may make this person the deputy, or take it off, here.
   onUpdated: what is saved, before the deputy's own call. */
function EditForm({ person, org, titleOnly, rename, telegram: telegramShown, deputy, onUpdated, onSaved, onClose }: { person: PersonView; org: Org | null; titleOnly: boolean; rename: boolean; telegram: boolean; deputy: boolean; onUpdated: (p: PersonView) => void; onSaved: (p: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(person.name);
  const [title, setTitle] = useState(person.title);
  const [telegram, setTelegram] = useState(() => telegramOf(person));
  const [choice, setChoice] = useState<Choice>(() => ({ access: accessInput(person.access), deputy: Boolean(person.isCeoDelegate), before: null }));
  const { access, deputy: isDeputy } = choice;
  const rights = { rename, titleOnly, telegram: telegramShown };
  const draft = { name, title, access, telegram };
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const res = await api.patch<{ person: PersonView }>(
        `/api/people/${person.id}`,
        changesOf(person, rights, draft),
      );
      /* The row shows what is saved even if the deputy's own call, which needs that access, fails after it. */
      onUpdated(res.person);
      onSaved(deputyCall(isDeputy, person, res.person) ? (await api.put<{ person: PersonView }>(`/api/people/${person.id}/ceo-delegate`, { isCeoDelegate: isDeputy })).person : res.person);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title"><EditIcon />{t.people.editHeading(person.name)}</h2>
      </div>
      <form onSubmit={e => void submit(e)} className="form-grid">
        <NameAndTitle rename={rename} name={name} title={title} onName={setName} onTitle={setTitle} />
        {telegramShown && (
          <Field label={t.people.telegram} hint={t.people.telegramHint}>
            {p => <input {...p} className="mono" value={telegram} onChange={e => setTelegram(e.target.value)} maxLength={64} placeholder={t.people.telegramPlaceholder} autoComplete="off" spellCheck={false} />}
          </Field>
        )}
        {!titleOnly && <AccessPicker org={org} value={access} onChange={a => setChoice(c => deputyRule.accessed(c, a))} />}
        {deputy && <DeputySwitch on={isDeputy} onChange={on => setChoice(c => deputyRule.switched(c, on))} />}
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || !fillable(rights, draft)}>
            <BusyLabel busy={busy} idle={t.common.save} working={t.common.saving} />
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
        </div>
      </form>
    </Edge>
  );
}

function PersonDetails({ person, org, onClose }: { person: PersonView; org: Org | null; onClose: () => void }) {
  const t = useT();
  return <Edge className="panel form-card" cut={12}>
    <div className="form-head">
      <h2 className="form-title">{person.assistant ? <AgentIcon /> : <PersonIcon />}{person.name}</h2>
    </div>
    <p>{person.title}</p>
    <p>{person.assistant ? t.people.actsFor(person.assistant.owner.name) : accessText(t, person.access, org)}</p>
    {telegramOf(person) && <p>{t.people.telegram}: {telegramOf(person)}</p>}
    <div className="form-foot">
      <button className="btn ghost" type="button" onClick={onClose}>{t.common.done}</button>
    </div>
  </Edge>;
}

/* The delegate's access, status and sign-in are the CEO's alone to change. */
const delegateLocked = (me: Me, p: PersonView): boolean => Boolean(p.isCeoDelegate) && !me.person.isOwner;
/* The CEO alone makes someone active the deputy, and takes it off anyone who has it. */
const deputyOn = (me: Me, p: PersonView): boolean => me.person.isOwner && !p.isOwner && (Boolean(p.isCeoDelegate) || p.status === 'active');

/* Whose name this person may change, as the server's guard has it: their own, and anyone's for the CEO and for the deputy
   who sees the whole company. Having the whole company alone is not enough. */
const renames = (me: Me, p: PersonView): boolean => p.id === me.person.id || me.person.isOwner || (Boolean(me.person.isCeoDelegate) && me.person.scopeKind === 'company');

/* Whose Telegram this person may set, as the server's guard has it: their own, and anyone's they manage. */
const setsTelegram = (me: Me, p: PersonView): boolean => p.id === me.person.id || rightsOn(me, p).manageable;

/* What this person may do on another's row. */
function rightsOn(me: Me, p: PersonView): { manageable: boolean; titleOnly: boolean; deputy: boolean } {
  const canManage = me.person.scopeKind === 'company';
  const locked = delegateLocked(me, p);
  const manageable = canManage && !p.isOwner && p.id !== me.person.id && !locked;
  const titleOnly = !manageable && (p.id === me.person.id || (canManage && (p.isOwner || locked)));
  return { manageable, titleOnly, deputy: deputyOn(me, p) };
}

/* The deputy's mark by the name: a hat and a short word that stay on one line, with the whole name of the post on hover
   and for screen readers. The space keeps the name and the post apart for them, and takes no room on the screen. */
function DeputyMark() {
  const t = useT();
  return (
    <>
      {' '}
      <span className="badge deputy" role="img" aria-label={t.people.ceoDelegate} title={t.people.ceoDelegate}>
        <DeputyIcon />
        {t.people.deputyShort}
      </span>
    </>
  );
}

type PersonEdit = { person: PersonView; titleOnly: boolean; deputy: boolean };

function selectionOf(me: Me, selected: CardRoute['selected'], people: PersonView[] | null, panel: Panel) {
  const person = selected ? people?.find(p => p.id === selected) : null;
  const edit = person ? { person, ...rightsOn(me, person) } : selected === undefined && panel?.kind === 'edit' ? panel : null;
  return { person, edit };
}

function InvitationPanel({ panel, ...invite }: { panel: Panel } & Invite) {
  const t = useT();
  return <>
    {panel?.kind === 'invite' && <InviteForm {...invite} />}
    {panel?.kind === 'assistant' && <NewAssistant me={invite.me} people={invite.people} own heading={t.people.newAssistant} initial={{ name: '', title: '' }} onMade={invite.onAssistant} onClose={invite.onClose} />}
    {panel?.kind === 'link' && <InviteLink name={panel.name} url={panel.url} onClose={invite.onClose} />}
  </>;
}

type EditPanel = { edit: PersonEdit | null; me: Me; org: Org | null; people: PersonView[]; onUpdated: (person: PersonView) => void; onSaved: (person: PersonView) => void; onClose: () => void };

function AssistantPanel({ edit, me, org, people, onUpdated, onSaved, onClose }: EditPanel & { edit: PersonEdit }) {
  if (!looksAfter(me, edit.person, people)) return <PersonDetails person={edit.person} org={org} onClose={onClose} />;
  return <AssistantCard key={edit.person.id} me={me} person={edit.person} manages={rightsOn(me, edit.person).manageable} rename={renames(me, edit.person)} onChanged={onUpdated} onSaved={onSaved} onClose={onClose} />;
}

function PersonEditPanel(props: EditPanel) {
  const { edit, me, org, onUpdated, onSaved, onClose } = props;
  if (!edit) return null;
  if (edit.person.assistant) return <AssistantPanel {...props} edit={edit} />;
  const canEdit = rightsOn(me, edit.person).manageable || edit.titleOnly;
  if (!canEdit) return <PersonDetails person={edit.person} org={org} onClose={onClose} />;
  return <EditForm key={edit.person.id} person={edit.person} org={org} titleOnly={edit.titleOnly} rename={renames(me, edit.person)} telegram={setsTelegram(me, edit.person)} deputy={edit.deputy} onUpdated={onUpdated} onSaved={onSaved} onClose={onClose} />;
}

/* A person's name with their mark, or an assistant's as an agent's, with whom it acts for under it. */
function NameCell({ p, routed, openPerson }: { p: PersonView; routed: boolean; openPerson: (person: PersonView) => void }) {
  const t = useT();
  const inner = <>{p.assistant ? <AgentIcon /> : <PersonIcon />}{p.name}{p.isCeoDelegate && <DeputyMark />}</>;
  /* One box, so the narrow layout keeps the note under the name and not under the column's label. */
  return <div className="pwho">
    {routed ? <button className="linkish pname" type="button" onClick={() => openPerson(p)}>{inner}</button> : <span className="pname">{inner}</span>}
    {/* The space keeps the name and the note apart for screen readers, and takes no room on the screen. */}
    {p.assistant && <>{' '}<span className="pnote">{t.people.assistantOf(p.assistant.owner.name)}</span></>}
  </div>;
}

type Row = { p: PersonView; me: Me; org: Org | null; people: PersonView[]; routed: boolean; openPerson: (person: PersonView) => void; newLink: (person: PersonView) => Promise<void>; setStatus: (person: PersonView, status: 'active' | 'disabled') => Promise<void>; askDelete: (person: PersonView) => void };

/* What one may do on a row: edit it, send a new invite link, which an assistant never takes, switch it off or on, and for
   the CEO, delete it. */
function rowRights(me: Me, p: PersonView, people: PersonView[]) {
  const { manageable, titleOnly } = rightsOn(me, p);
  return { edits: p.assistant ? looksAfter(me, p, people) : manageable || titleOnly, links: manageable && !p.assistant, manageable, deletes: manageable && me.person.isOwner };
}

function PersonRow({ p, me, org, people, routed, openPerson, newLink, setStatus, askDelete }: Row) {
  const t = useT();
  const { edits, links, manageable, deletes } = rowRights(me, p, people);
  return (
    <tr className={p.status}>
      <td data-label={t.people.columns.name}><NameCell p={p} routed={routed} openPerson={openPerson} /></td>
      <td data-label={t.people.columns.title}>{p.title}</td>
      <td data-label={t.people.columns.access}>{p.assistant ? t.people.sameAs(p.assistant.owner.name) : accessText(t, p.access, org)}</td>
      <td data-label={t.people.columns.status}><span className={`status ${p.status}`}>{t.people.status[p.status]}</span></td>
      <td className="row-actions" data-label={t.people.columns.actions}>
        <div className="entry-actions" role="group" aria-label={`${t.people.columns.actions}: ${p.name}`}>
          {edits && (
            <button className="act" type="button" aria-label={t.people.editLabel(p.name)} onClick={() => openPerson(p)}>{t.people.edit}</button>
          )}
          {manageable && (
            <>
              {links && <button className="act" type="button" aria-label={t.people.newLinkLabel(p.name)} onClick={() => void newLink(p)}>{t.people.newLink}</button>}
              {p.status === 'disabled' ? (
                <button className="act" type="button" aria-label={t.people.enableLabel(p.name)} onClick={() => void setStatus(p, 'active')}>{t.people.enable}</button>
              ) : (
                <button className="act danger" type="button" aria-label={t.people.disableLabel(p.name)} onClick={() => void setStatus(p, 'disabled')}>{t.people.disable}</button>
              )}
            </>
          )}
          {deletes && <button className="act danger" type="button" aria-label={t.people.deleteLabel(p.name)} onClick={() => askDelete(p)}>{t.people.delete}</button>}
        </div>
      </td>
    </tr>
  );
}

/* What the shell shows of you follows the name saved on your own row. */
const tellOwnName = (me: Me, person: PersonView, onRenamed?: (name: string) => void): void => {
  if (person.id === me.person.id) onRenamed?.(person.name);
};

function usePeopleTable(people: PersonView[] | null) {
  const { language } = useLanguage();
  const tableHost = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = tableHost.current;
    const table = host?.querySelector('table');
    if (!host || !table) return;
    const measure = () => fitTable(table);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'people');
    observer.observe(host);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [people, language]);

  return tableHost;
}

function renamePerson(people: PersonView[] | null, id: string, name: string): PersonView[] | null {
  return people?.map(p => p.id === id ? { ...p, name } : p) ?? null;
}

function useOwnName(me: Me, setPeople: (update: (list: PersonView[] | null) => PersonView[] | null) => void) {
  const previousName = useRef(me.person.name);
  useEffect(() => {
    if (previousName.current === me.person.name) return;
    previousName.current = me.person.name;
    setPeople(list => renamePerson(list, me.person.id, me.person.name));
  }, [me.person.id, me.person.name]);
}

function replacePerson(people: PersonView[] | null, person: PersonView): PersonView[] | null {
  return people?.map(p => (p.id === person.id ? person : p)) ?? null;
}

const missingSelection = (selected: CardRoute['selected'], people: PersonView[] | null, person: PersonView | null | undefined) => selected && people && !person;

const peopleUnavailable = (failure: unknown, selected: CardRoute['selected'], people: PersonView[] | null, person: PersonView | null | undefined) =>
  unavailableFailure(failure) || missingSelection(selected, people, person);

/* Someone with the whole company invites people; anyone else adds their own assistant here. */
function PeopleHeader({ canManage, panel, onInvite, onAssistant }: { canManage: boolean; panel: Panel; onInvite: () => void; onAssistant: () => void }) {
  const t = useT();
  return (
      <header className="people-head">
        <div>
          <h1>{t.people.heading}</h1>
          <p className="muted">{t.people.intro}</p>
        </div>
        {!panel && (canManage
          ? <button className="btn" type="button" onClick={onInvite}>{t.people.invitePerson}</button>
          : <button className="btn" type="button" onClick={onAssistant}>{t.people.addMyAssistant}</button>)}
      </header>
  );
}

/* The people's table head: drawn at once while they come, and over them once they came. */
function PeopleHead() {
  const t = useT();
  return (
    <thead>
      <tr>
        <th scope="col">{t.people.columns.name}</th>
        <th scope="col">{t.people.columns.title}</th>
        <th scope="col">{t.people.columns.access}</th>
        <th scope="col">{t.people.columns.status}</th>
        <th scope="col"><span className="sr">{t.people.columns.actions}</span></th>
      </tr>
    </thead>
  );
}

/* A person while the people come: the name with its note under it, the title, the access and the status as idle bars. */
function HeldPerson() {
  return (
    <tr className="held">
      <td><span className="pwho"><Idle w="12ch" /><span className="pnote"><Idle w="18ch" /></span></span></td>
      <td><Idle w="10ch" /></td>
      <td><Idle w="12ch" /></td>
      <td><Idle w="6ch" /></td>
      <td />
    </tr>
  );
}

/* A list with no count kept for the session holds this many people. */
const HELD_PEOPLE = 3;
const useHeldPeople = (people: PersonView[] | null): number => useHeldRows('people', people ? people.length : null) ?? HELD_PEOPLE;
/* A failure to load says itself over the people once they came; before that their held table says it. */
const overPeople = (people: PersonView[] | null, failure: unknown) => (people ? failure : null);

/* The people's table while they come (style book 1.5, section 4; Design #1656): its head at once; in its first row the ring
   and its words, or why the load stalled with Retry; held people under it, as many as it showed last. */
function HeldPeople({ load, rows, host }: { load: Load; rows: number; host: RefObject<HTMLDivElement | null> }) {
  return (
    <Hold load={load} keep className="held-table">
      <div className="fit" ref={host}>
        <table className="ptable">
          <PeopleHead />
          <tbody>
            <tr className="held"><td colSpan={5}><LoadLine load={load} /></td></tr>
            {Array.from({ length: rows - 1 }, (_, i) => <HeldPerson key={i} />)}
          </tbody>
        </table>
      </div>
    </Hold>
  );
}

/* Under the list, and with it, so nothing moves when the list comes: who may act for the CEO, and that agents are elsewhere. */
function PeopleFoot({ me }: { me: Me }) {
  const t = useT();
  return <>
    {me.person.isOwner && <p className="muted">{t.people.ceoDelegate}: {t.people.ceoDelegateHint}</p>}
    <p className="muted people-foot"><AgentIcon /> {t.people.agentsNote}</p>
  </>;
}

export function People({ me, selected, onSelect, onHome, onRenamed }: { me: Me; onRenamed?: (name: string) => void } & CardRoute) {
  const t = useT();
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [askPeople] = useState(latestAnswers);
  const canManage = me.person.scopeKind === 'company';

  const load = useCallback(async () => {
    const fresh = askPeople();
    try {
      const [list, structure] = await Promise.all([api.get<{ people: PersonView[] }>('/api/people'), api.get<Org>('/api/org')]);
      if (!fresh()) return;
      setPeople(list.people);
      setOrg(structure);
      setLoadFailure(null);
    } catch (err) {
      if (fresh()) setLoadFailure(err);
    }
  }, [askPeople]);

  useEffect(() => {
    void load();
  }, [load]);
  /* The people come into their held table, which says why when they do not. */
  const peopleLoad = useLoad([{ data: people, failure: loadFailure, load }]);
  const shown = doneOf(people, peopleLoad);
  const heldPeople = useHeldPeople(shown);
  const tableHost = usePeopleTable(shown);
  /* After a break, an update among them, the list is read again. */
  useStream(m => {
    if (m.type === 'reconnected') void load();
  });

  useOwnName(me, setPeople);

  const replace = (person: PersonView) => {
    setPeople(list => replacePerson(list, person));
    setPanel(p => (p?.kind === 'edit' && p.person.id === person.id ? { ...p, person } : p));
    tellOwnName(me, person, onRenamed);
  };
  const { person, edit } = selectionOf(me, selected, people, panel);
  const closePerson = () => { onSelect?.(null); setPanel(null); };
  const openPerson = (person: PersonView) => {
    if (onSelect) onSelect(person.id);
    else setPanel({ kind: 'edit', person, ...rightsOn(me, person) });
  };
  /* A new assistant joins the list and its card opens, for its key. */
  const added = (person: PersonView) => {
    setPeople(list => [...(list ?? []), person]);
    openPerson(person);
  };

  async function run(action: () => Promise<void>) {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(err);
    }
  }

  const setStatus = (person: PersonView, status: 'active' | 'disabled') =>
    run(async () => replace((await api.patch<{ person: PersonView }>(`/api/people/${person.id}`, { status })).person));

  const removePerson = (person: PersonView) =>
    run(async () => {
      await api.del(`/api/people/${person.id}`);
      if (selected === person.id) onSelect?.(null);
      setPeople(list => list?.filter(p => p.id !== person.id) ?? null);
      setPanel(null);
    });

  const newLink = (person: PersonView) =>
    run(async () => {
      const res = await api.post<{ person: PersonView; inviteUrl: string }>(`/api/people/${person.id}/invite`);
      replace(res.person);
      setPanel({ kind: 'link', name: res.person.name, url: res.inviteUrl });
    });

  if (unavailableFailure(loadFailure) || peopleUnavailable(failure, selected, people, person)) return <RouteUnavailable onHome={onHome} />;

  return (
    <section className="people">
      <PeopleHeader canManage={canManage} panel={panel} onInvite={() => setPanel({ kind: 'invite' })} onAssistant={() => setPanel({ kind: 'assistant' })} />

      <InvitationPanel
        panel={panel}
        org={org}
        me={me}
        people={people ?? []}
        onSent={(name, url) => {
          setPanel({ kind: 'link', name, url });
          void load();
        }}
        onAssistant={added}
        onClose={() => setPanel(null)}
      />
      <PersonEditPanel
        edit={edit}
        me={me}
        org={org}
        people={people ?? []}
        onUpdated={replace}
        onSaved={person => {
          replace(person);
          closePerson();
        }}
        onClose={closePerson}
      />
      {panel?.kind === 'delete' && <DeleteAsk person={panel.person} onYes={() => removePerson(panel.person)} onClose={() => setPanel(null)} />}
      <LoadFailure failure={overPeople(people, loadFailure)} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {shown ? (<>
        <div className="fit" ref={tableHost}>
          <table className="ptable">
            <PeopleHead />
            <tbody>
              {shown.map(p => <PersonRow key={p.id} p={p} me={me} org={org} people={shown} routed={Boolean(onSelect)} openPerson={openPerson} newLink={newLink} setStatus={setStatus} askDelete={person => setPanel({ kind: 'delete', person })} />)}
            </tbody>
          </table>
        </div>
        <PeopleFoot me={me} />
      </>) : <HeldPeople load={peopleLoad} rows={heldPeople} host={tableHost} />}
    </section>
  );
}
