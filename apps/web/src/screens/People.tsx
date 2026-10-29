import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import type { Me, Org, PersonView } from '../types';
import { CopyButton } from '../ui/CopyButton';
import { Edge } from '../ui/Edge';
import { Field } from '../ui/Field';
import { AgentIcon, PersonIcon } from '../ui/icons';

const STATUS: Record<PersonView['status'], string> = { active: 'Active', invited: 'Invited', disabled: 'Disabled' };

type Scope = { kind: 'company' } | { kind: 'department' | 'team'; id: string };
type ScopeOption = { value: string; label: string; scope: Scope };
type Panel = { kind: 'invite' } | { kind: 'link'; name: string; url: string } | { kind: 'edit'; person: PersonView } | null;

function scopeOptions(org: Org | null): ScopeOption[] {
  const options: ScopeOption[] = [{ value: 'company', label: 'Whole company', scope: { kind: 'company' } }];
  for (const d of org?.departments ?? []) options.push({ value: `department:${d.id}`, label: d.name, scope: { kind: 'department', id: d.id } });
  for (const d of org?.departments ?? []) {
    for (const t of d.teams) options.push({ value: `team:${t.id}`, label: `${d.name} / ${t.name}`, scope: { kind: 'team', id: t.id } });
  }
  return options;
}

const scopeValue = (p: PersonView) => (p.scope.kind === 'company' ? 'company' : `${p.scope.kind}:${p.scope.id}`);
const message = (err: unknown) => (err instanceof ApiFailure ? err.message : 'Something went wrong.');

function ScopeSelect({ options, value, onChange }: { options: ScopeOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Scope" hint="What they can see and who they can write to.">
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
  return (
    <Edge className="panel" cut={12}>
      <h2>Invite link for {name}</h2>
      <p className="muted">Send this link to {name} yourself. It works once and expires in 7 days. Hornhoof shows it only now.</p>
      <div className="command">
        <code>{url}</code>
        <CopyButton text={url} label="Copy link" />
      </div>
      <div className="actions">
        <button className="btn" type="button" onClick={onClose}>Done</button>
      </div>
    </Edge>
  );
}

function InviteForm({ options, onSent, onClose }: { options: ScopeOption[]; onSent: (name: string, url: string) => void; onClose: () => void }) {
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
      setFailure(message(err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>Invite person</h2>
      <form onSubmit={submit} className="panel-form">
        <Field label="Name">{p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus required />}</Field>
        <Field label="Email">{p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} required />}</Field>
        <Field label="Title">{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="Head of marketing" />}</Field>
        <ScopeSelect options={options} value={scope} onChange={setScope} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={busy || !name.trim() || !email.trim()}>Send invite</button>
        </div>
      </form>
    </Edge>
  );
}

function EditForm({ person, options, onSaved, onClose }: { person: PersonView; options: ScopeOption[]; onSaved: (p: PersonView) => void; onClose: () => void }) {
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
      setFailure(message(err));
      setBusy(false);
    }
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>Edit {person.name}</h2>
      <form onSubmit={submit} className="panel-form">
        <Field label="Title">{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} autoFocus />}</Field>
        <ScopeSelect options={options} value={scope} onChange={setScope} />
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={busy}>Save</button>
        </div>
      </form>
    </Edge>
  );
}

export function People({ me }: { me: Me }) {
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [failure, setFailure] = useState('');
  const canManage = me.person.scopeKind === 'company';
  const options = scopeOptions(org);

  const load = useCallback(async () => {
    try {
      const [list, structure] = await Promise.all([api.get<{ people: PersonView[] }>('/api/people'), api.get<Org>('/api/org')]);
      setPeople(list.people);
      setOrg(structure);
    } catch (err) {
      setFailure(message(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (person: PersonView) => setPeople(list => list?.map(p => (p.id === person.id ? person : p)) ?? null);

  async function run(action: () => Promise<void>) {
    setFailure('');
    try {
      await action();
    } catch (err) {
      setFailure(message(err));
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
          <h1>People</h1>
          <p className="muted">People work next to the agents. Each one sees the whole company, one department or one team.</p>
        </div>
        {canManage && !panel && (
          <button className="btn" type="button" onClick={() => setPanel({ kind: 'invite' })}>Invite person</button>
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
      {failure && <p className="alert" role="alert">{failure}</p>}

      {people && (
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Title</th>
              <th scope="col">Scope</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="sr">Actions</span></th>
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
                  <td>{p.scope.name}</td>
                  <td><span className={`status ${p.status}`}>{STATUS[p.status]}</span></td>
                  <td className="row-actions">
                    {editable && (
                      <>
                        <button className="linkbtn" type="button" aria-label={`Edit ${p.name}`} onClick={() => setPanel({ kind: 'edit', person: p })}>Edit</button>
                        <button className="linkbtn" type="button" aria-label={`New invite link for ${p.name}`} onClick={() => newLink(p)}>New link</button>
                        {p.status === 'disabled' ? (
                          <button className="linkbtn" type="button" aria-label={`Enable ${p.name}`} onClick={() => setStatus(p, 'active')}>Enable</button>
                        ) : (
                          <button className="linkbtn" type="button" aria-label={`Disable ${p.name}`} onClick={() => setStatus(p, 'disabled')}>Disable</button>
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
      <p className="muted people-foot"><AgentIcon /> Agents are not listed here. They live on the map, inside their departments.</p>
    </section>
  );
}
