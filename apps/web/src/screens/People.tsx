import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import type { Me, Org, PersonView } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';
import { AgentIcon, PersonIcon } from '../ui/icons';

type Scope = { kind: 'company' } | { kind: 'department' | 'team'; id: string };
type ScopeOption = { value: string; label: string; scope: Scope };
type Panel = { kind: 'invite' } | { kind: 'link'; name: string; url: string } | { kind: 'edit'; person: PersonView } | null;

function scopeOptions(t: Messages, org: Org | null): ScopeOption[] {
  const options: ScopeOption[] = [{ value: 'company', label: t.people.wholeCompany, scope: { kind: 'company' } }];
  for (const d of org?.departments ?? []) options.push({ value: `department:${d.id}`, label: deptLabel(t, d), scope: { kind: 'department', id: d.id } });
  for (const d of org?.departments ?? []) {
    for (const team of d.teams) options.push({ value: `team:${team.id}`, label: `${deptLabel(t, d)} / ${team.name}`, scope: { kind: 'team', id: team.id } });
  }
  return options;
}

const scopeValue = (p: PersonView) => (p.scope.kind === 'company' ? 'company' : `${p.scope.kind}:${p.scope.id}`);
const scopeName = (t: Messages, p: PersonView) => (p.scope.kind === 'company' ? t.people.wholeCompany : p.scope.name);

function ScopeSelect({ options, value, onChange }: { options: ScopeOption[]; value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <Field label={t.people.scope} hint={t.people.scopeHint}>
      {p => (
        <select {...p} value={value} onChange={e => onChange(e.target.value)}>
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

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

function InviteForm({ options, onSent, onClose }: { options: ScopeOption[]; onSent: (name: string, url: string) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('company');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const res = await api.post<{ person: PersonView; inviteUrl: string }>('/api/people/invite', {
        name: name.trim(),
        email: email.trim(),
        title: title.trim(),
        scope: options.find(o => o.value === scope)!.scope,
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
      <form onSubmit={submit} className="panel-form">
        <Field label={t.common.name}>{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}</Field>
        <Field label={t.common.email}>{p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} required />}</Field>
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder={t.people.titlePlaceholder} />}</Field>
        <ScopeSelect options={options} value={scope} onChange={setScope} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy || !name.trim() || !email.trim()}>{t.people.sendInvite}</button>
        </div>
      </form>
    </Edge>
  );
}

function EditForm({ person, options, onSaved, onClose }: { person: PersonView; options: ScopeOption[]; onSaved: (p: PersonView) => void; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(person.title);
  const [scope, setScope] = useState(scopeValue(person));
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const res = await api.patch<{ person: PersonView }>(`/api/people/${person.id}`, {
        title: title.trim(),
        scope: options.find(o => o.value === scope)!.scope,
      });
      onSaved(res.person);
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>{t.people.editHeading(person.name)}</h2>
      <form onSubmit={submit} className="panel-form">
        <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} autoFocus />}</Field>
        <ScopeSelect options={options} value={scope} onChange={setScope} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
          <button className="btn" type="submit" disabled={busy}>{t.common.save}</button>
        </div>
      </form>
    </Edge>
  );
}

export function People({ me }: { me: Me }) {
  const t = useT();
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const canManage = me.person.scopeKind === 'company';
  const options = scopeOptions(t, org);

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
          options={options}
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
          options={options}
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
              <th scope="col">{t.people.columns.scope}</th>
              <th scope="col">{t.people.columns.status}</th>
              <th scope="col"><span className="sr">{t.people.columns.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => {
              const editable = canManage && !p.isOwner && p.id !== me.person.id;
              return (
                <tr key={p.id} className={p.status}>
                  <td>
                    <span className="pname"><PersonIcon />{p.name}</span>
                  </td>
                  <td>{p.title}</td>
                  <td>{scopeName(t, p)}</td>
                  <td><span className={`status ${p.status}`}>{t.people.status[p.status]}</span></td>
                  <td className="row-actions">
                    {editable && (
                      <>
                        <button className="linkbtn" type="button" aria-label={t.people.editLabel(p.name)} onClick={() => setPanel({ kind: 'edit', person: p })}>{t.people.edit}</button>
                        <button className="linkbtn" type="button" aria-label={t.people.newLinkLabel(p.name)} onClick={() => newLink(p)}>{t.people.newLink}</button>
                        {p.status === 'disabled' ? (
                          <button className="linkbtn" type="button" aria-label={t.people.enableLabel(p.name)} onClick={() => setStatus(p, 'active')}>{t.people.enable}</button>
                        ) : (
                          <button className="linkbtn" type="button" aria-label={t.people.disableLabel(p.name)} onClick={() => setStatus(p, 'disabled')}>{t.people.disable}</button>
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
      <p className="muted people-foot"><AgentIcon /> {t.people.agentsNote}</p>
    </section>
  );
}
