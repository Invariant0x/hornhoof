import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { AccessInput, Me, Org, PersonView } from '../types';
import { accessEmpty, accessInput, AccessPicker, accessText } from '../ui/AccessPicker';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';
import { AgentIcon, DeputyIcon, PersonIcon } from '../ui/icons';
import { RouteUnavailable, unavailableFailure, type CardRoute } from './RouteUnavailable';

type Panel = { kind: 'invite' } | { kind: 'link'; name: string; url: string } | { kind: 'edit'; person: PersonView; titleOnly: boolean; deputy: boolean } | null;

function InviteLink({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const t = useT();
  return (
    <Edge className="panel" cut={12}>
      <h2>{t.people.linkFor(name)}</h2>
      <p className="muted">{t.people.linkNote(name)}</p>
      <div className="command">
        <code>{url}</code>
        <CopyButton text={url} label={t.people.copyLink} />
      </div>
      <div className="actions">
        <button className="btn" type="button" onClick={onClose}>{t.common.done}</button>
      </div>
    </Edge>
  );
}

function InviteForm({ org, onSent, onClose }: { org: Org | null; onSent: (name: string, url: string) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [access, setAccess] = useState<AccessInput>({ whole: true });
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

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
    <Edge className="panel" cut={12}>
      <h2>{t.people.invitePerson}</h2>
      <form onSubmit={e => void submit(e)} className="panel-form">
        <Field label={t.common.name}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}</Field>
        <Field label={t.common.email}>{p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} required />}</Field>
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder={t.people.titlePlaceholder} />}</Field>
        <AccessPicker org={org} value={access} onChange={setAccess} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || !name.trim() || !email.trim() || accessEmpty(access)}>{t.people.sendInvite}</button>
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

/* The CEO's switch for the deputy, right after the access, with what it gives under it. */
function DeputySwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const id = useId();
  return (
    <label className="check">
      <input type="checkbox" role="switch" checked={on} onChange={e => onChange(e.target.checked)} aria-labelledby={`${id}-name`} aria-describedby={`${id}-about`} />
      <span>
        <b id={`${id}-name`}>{t.people.ceoDelegate}</b>
        <small id={`${id}-about`}>{t.people.deputyAbout}</small>
      </span>
    </label>
  );
}

/* Your own row and the owner's take a new title only: access is not theirs to change here. deputy: the CEO may make this
   person the deputy, or take it off, here. onUpdated: what is saved, before the deputy's own call. */
function EditForm({ person, org, titleOnly, deputy, onUpdated, onSaved, onClose }: { person: PersonView; org: Org | null; titleOnly: boolean; deputy: boolean; onUpdated: (p: PersonView) => void; onSaved: (p: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(person.title);
  const [choice, setChoice] = useState<Choice>(() => ({ access: accessInput(person.access), deputy: Boolean(person.isCeoDelegate), before: null }));
  const { access, deputy: isDeputy } = choice;
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const res = await api.patch<{ person: PersonView }>(
        `/api/people/${person.id}`,
        titleOnly ? { title: title.trim() } : { title: title.trim(), access },
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
    <Edge className="panel" cut={12}>
      <h2>{t.people.editHeading(person.name)}</h2>
      <form onSubmit={e => void submit(e)} className="panel-form">
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} autoFocus />}</Field>
        {!titleOnly && <AccessPicker org={org} value={access} onChange={a => setChoice(c => deputyRule.accessed(c, a))} />}
        {deputy && <DeputySwitch on={isDeputy} onChange={on => setChoice(c => deputyRule.switched(c, on))} />}
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || (!titleOnly && accessEmpty(access))}>{t.common.save}</button>
        </div>
      </form>
    </Edge>
  );
}

function PersonDetails({ person, org, onClose }: { person: PersonView; org: Org | null; onClose: () => void }) {
  const t = useT();
  return <Edge className="panel" cut={12}>
    <h2>{person.name}</h2>
    <p>{person.title}</p>
    <p>{accessText(t, person.access, org)}</p>
    <button className="btn ghost" type="button" onClick={onClose}>{t.common.done}</button>
  </Edge>;
}

/* The delegate's access, status and sign-in are the CEO's alone to change. */
const delegateLocked = (me: Me, p: PersonView): boolean => Boolean(p.isCeoDelegate) && !me.person.isOwner;
/* The CEO alone makes someone active the deputy, and takes it off anyone who has it. */
const deputyOn = (me: Me, p: PersonView): boolean => me.person.isOwner && !p.isOwner && (Boolean(p.isCeoDelegate) || p.status === 'active');

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

export function People({ me, selected, onSelect, onHome }: { me: Me } & CardRoute) {
  const t = useT();
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const canManage = me.person.scopeKind === 'company';

  const load = useCallback(async () => {
    try {
      const [list, structure] = await Promise.all([api.get<{ people: PersonView[] }>('/api/people'), api.get<Org>('/api/org')]);
      setPeople(list.people);
      setOrg(structure);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const previousName = useRef(me.person.name);
  useEffect(() => {
    if (previousName.current === me.person.name) return;
    previousName.current = me.person.name;
    setPeople(list => list?.map(p => p.id === me.person.id ? { ...p, name: me.person.name } : p) ?? null);
  }, [me.person.id, me.person.name]);

  const replace = (person: PersonView) => setPeople(list => list?.map(p => (p.id === person.id ? person : p)) ?? null);
  const person = selected ? people?.find(p => p.id === selected) : null;
  const edit = person ? { person, ...rightsOn(me, person) } : selected === undefined && panel?.kind === 'edit' ? panel : null;
  const canEdit = edit && (rightsOn(me, edit.person).manageable || edit.titleOnly);
  const closePerson = () => { onSelect?.(null); setPanel(null); };
  const openPerson = (person: PersonView) => {
    if (onSelect) onSelect(person.id);
    else setPanel({ kind: 'edit', person, ...rightsOn(me, person) });
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

  const newLink = (person: PersonView) =>
    run(async () => {
      const res = await api.post<{ person: PersonView; inviteUrl: string }>(`/api/people/${person.id}/invite`);
      replace(res.person);
      setPanel({ kind: 'link', name: res.person.name, url: res.inviteUrl });
    });

  if (unavailableFailure(failure) || (selected && people && !person)) return <RouteUnavailable onHome={onHome} />;

  return (
    <section className="people">
      <header className="people-head">
        <div>
          <h1>{t.people.heading}</h1>
          <p className="muted">{t.people.intro}</p>
        </div>
        {canManage && !panel && (
          <button className="btn" type="button" onClick={() => setPanel({ kind: 'invite' })}>{t.people.invitePerson}</button>
        )}
      </header>

      {panel?.kind === 'invite' && (
        <InviteForm
          org={org}
          onSent={(name, url) => {
            setPanel({ kind: 'link', name, url });
            void load();
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'link' && <InviteLink name={panel.name} url={panel.url} onClose={() => setPanel(null)} />}
      {edit && !canEdit && <PersonDetails person={edit.person} org={org} onClose={closePerson} />}
      {edit && canEdit && (
        <EditForm
          key={edit.person.id}
          person={edit.person}
          org={org}
          titleOnly={edit.titleOnly}
          deputy={edit.deputy}
          onUpdated={replace}
          onSaved={person => {
            replace(person);
            closePerson();
          }}
          onClose={closePerson}
        />
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {people && (
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">{t.people.columns.name}</th>
              <th scope="col">{t.people.columns.title}</th>
              <th scope="col">{t.people.columns.access}</th>
              <th scope="col">{t.people.columns.status}</th>
              <th scope="col"><span className="sr">{t.people.columns.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => {
              const { manageable, titleOnly } = rightsOn(me, p);
              return (
                <tr key={p.id} className={p.status}>
                  <td>
                    {onSelect ? <button className="linkish pname" type="button" onClick={() => openPerson(p)}><PersonIcon />{p.name}{p.isCeoDelegate && <DeputyMark />}</button> : <span className="pname"><PersonIcon />{p.name}{p.isCeoDelegate && <DeputyMark />}</span>}
                  </td>
                  <td>{p.title}</td>
                  <td>{accessText(t, p.access, org)}</td>
                  <td><span className={`status ${p.status}`}>{t.people.status[p.status]}</span></td>
                  <td className="row-actions">
                    {(manageable || titleOnly) && (
                      <button className="act" type="button" aria-label={t.people.editLabel(p.name)} onClick={() => openPerson(p)}>{t.people.edit}</button>
                    )}
                    {manageable && (
                      <>
                        <button className="act" type="button" aria-label={t.people.newLinkLabel(p.name)} onClick={() => void newLink(p)}>{t.people.newLink}</button>
                        {p.status === 'disabled' ? (
                          <button className="act" type="button" aria-label={t.people.enableLabel(p.name)} onClick={() => void setStatus(p, 'active')}>{t.people.enable}</button>
                        ) : (
                          <button className="act danger" type="button" aria-label={t.people.disableLabel(p.name)} onClick={() => void setStatus(p, 'disabled')}>{t.people.disable}</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {me.person.isOwner && <p className="muted">{t.people.ceoDelegate}: {t.people.ceoDelegateHint}</p>}
      <p className="muted people-foot"><AgentIcon /> {t.people.agentsNote}</p>
    </section>
  );
}
