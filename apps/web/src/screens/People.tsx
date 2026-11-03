import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { AccessInput, Me, Org, PersonView } from '../types';
import { accessEmpty, accessInput, AccessPicker, accessText } from '../ui/AccessPicker';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';
import { AgentIcon, PersonIcon } from '../ui/icons';

type Panel = { kind: 'invite' } | { kind: 'link'; name: string; url: string } | { kind: 'edit'; person: PersonView; titleOnly: boolean } | null;

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

/* Your own row and the owner's take a new title only: access is not theirs to change here. */
function EditForm({ person, org, titleOnly, onSaved, onClose }: { person: PersonView; org: Org | null; titleOnly: boolean; onSaved: (p: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(person.title);
  const [access, setAccess] = useState<AccessInput>(() => accessInput(person.access));
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
      onSaved(res.person);
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
        {!titleOnly && <AccessPicker org={org} value={access} onChange={setAccess} />}
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || (!titleOnly && accessEmpty(access))}>{t.common.save}</button>
        </div>
      </form>
    </Edge>
  );
}

/* The delegate's access, status and sign-in are the CEO's alone to change. */
const delegateLocked = (me: Me, p: PersonView): boolean => Boolean(p.isCeoDelegate) && !me.person.isOwner;
/* The CEO alone sets the mark, on someone active with the whole company, and takes it off anyone who has it. */
const marksOn = (me: Me, p: PersonView): boolean => me.person.isOwner && !p.isOwner && (Boolean(p.isCeoDelegate) || (p.status === 'active' && p.access.whole));

/* What this person may do on another's row. */
function rightsOn(me: Me, p: PersonView): { manageable: boolean; titleOnly: boolean; marks: boolean } {
  const canManage = me.person.scopeKind === 'company';
  const locked = delegateLocked(me, p);
  const manageable = canManage && !p.isOwner && p.id !== me.person.id && !locked;
  const titleOnly = !manageable && (p.id === me.person.id || (canManage && (p.isOwner || locked)));
  return { manageable, titleOnly, marks: marksOn(me, p) };
}

function DelegateTag({ person }: { person: PersonView }) {
  const t = useT();
  if (!person.isCeoDelegate) return null;
  return (
    <>
      {' '}
      <em className="t-card-tag">{t.people.ceoDelegate}</em>
    </>
  );
}

/* The CEO's tick that marks the delegate, who then takes the CEO's decisions, and takes the mark off. */
function DelegateMark({ person, onChange }: { person: PersonView; onChange: (on: boolean) => void }) {
  const t = useT();
  return (
    <label className="act delegate" title={t.people.ceoDelegateHint}>
      <input type="checkbox" checked={Boolean(person.isCeoDelegate)} aria-label={t.people.ceoDelegateLabel(person.name)} onChange={e => onChange(e.target.checked)} />
      {t.people.ceoDelegate}
    </label>
  );
}

export function People({ me }: { me: Me }) {
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

  const replace = (person: PersonView) => setPeople(list => list?.map(p => (p.id === person.id ? person : p)) ?? null);

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

  /* The CEO marks the delegate, who then takes the CEO's decisions, and takes the mark off. */
  const setDelegate = (person: PersonView, isCeoDelegate: boolean) =>
    run(async () => replace((await api.put<{ person: PersonView }>(`/api/people/${person.id}/ceo-delegate`, { isCeoDelegate })).person));

  const newLink = (person: PersonView) =>
    run(async () => {
      const res = await api.post<{ person: PersonView; inviteUrl: string }>(`/api/people/${person.id}/invite`);
      replace(res.person);
      setPanel({ kind: 'link', name: res.person.name, url: res.inviteUrl });
    });

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
      {panel?.kind === 'edit' && (
        <EditForm
          key={panel.person.id}
          person={panel.person}
          org={org}
          titleOnly={panel.titleOnly}
          onSaved={person => {
            replace(person);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
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
              const { manageable, titleOnly, marks } = rightsOn(me, p);
              return (
                <tr key={p.id} className={p.status}>
                  <td>
                    <span className="pname"><PersonIcon />{p.name}</span>
                    <DelegateTag person={p} />
                  </td>
                  <td>{p.title}</td>
                  <td>{accessText(t, p.access, org)}</td>
                  <td><span className={`status ${p.status}`}>{t.people.status[p.status]}</span></td>
                  <td className="row-actions">
                    {marks && <DelegateMark person={p} onChange={on => void setDelegate(p, on)} />}
                    {(manageable || titleOnly) && (
                      <button className="act" type="button" aria-label={t.people.editLabel(p.name)} onClick={() => setPanel({ kind: 'edit', person: p, titleOnly })}>{t.people.edit}</button>
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
