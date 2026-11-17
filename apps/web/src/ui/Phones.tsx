import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PhoneEndpoint, networkEndpoint, type PhoneDevice } from '@hornhoof/protocol';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { MachineView, Me } from '../types';
import { CardFrame, CardHead, EmptyBox, Facts, Part } from './Cards';
import { Field } from './Field';
import { PhoneScreen } from './PhoneScreen';

export type PhoneView = {
  id: string; name: string; owner: { id: string; name: string }; machineId: string; lending: boolean; online: boolean;
  state: 'owner' | 'busy' | 'available'; queued: number; stopping: boolean; endpoint?: string;
};
export type PhoneMachines = Pick<MachineView, 'id' | 'hostname' | 'online'>[];

/* An older read cannot undo Stop or a registration that finished after it started. */
export function Phones({ me, machines }: { me: Me; machines: PhoneMachines }) {
  const t = useT();
  const [phones, setPhones] = useState<PhoneView[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const version = ++epoch.current;
    try {
      const reply = await api.get<{ phones: PhoneView[] }>('/api/phones');
      if (version === epoch.current) { setPhones(reply.phones); setFailure(null); }
    } catch (error) { if (version === epoch.current) setFailure(error); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { clearInterval(timer); epoch.current++; };
  }, [load]);
  function changed(phone: PhoneView) {
    epoch.current++;
    setPhones(previous => [...(previous ?? []).filter(p => p.id !== phone.id), phone]);
  }
  return <section className="phones" aria-label={t.phones.heading}>
    <header className="people-head"><div><h2>{t.phones.heading}</h2><p className="muted">{t.phones.intro}</p></div>
      {!adding && <div className="entry-actions"><button className="btn" type="button" onClick={() => setAdding(true)}>{t.phones.add}</button></div>}
    </header>
    {adding && <AddPhone machines={machines} onCancel={() => setAdding(false)} onAdded={p => { changed(p); setAdding(false); }} />}
    {failure !== null && <div role="alert"><p className="bad">{errorText(t, failure)}</p><button type="button" className="btn" onClick={() => void load()}>{t.phones.retry}</button></div>}
    {phones === null && failure === null && <p role="status">{t.phones.loading}</p>}
    {phones?.length === 0 && <EmptyBox title={t.phones.empty} hint={t.phones.emptyHint} />}
    <div className="phone-cards">{phones?.map(phone => <PhoneCard key={phone.id} phone={phone} mine={phone.owner.id === me.person.id} machine={machines.find(m => m.id === phone.machineId)?.hostname ?? t.phones.computer} onChanged={changed} />)}</div>
  </section>;
}

type Draft = { name: string; machineId: string; endpoint: string; pairingAddress: string; code: string };
type Problems = Partial<Record<keyof Draft, string>>;

function AddPhone({ machines, onCancel, onAdded }: { machines: PhoneMachines; onCancel: () => void; onAdded: (p: PhoneView) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>({ name: '', machineId: machines.find(m => m.online)?.id ?? '', endpoint: '', pairingAddress: '', code: '' });
  const [problems, setProblems] = useState<Problems>({});
  const [devices, setDevices] = useState<PhoneDevice[] | null>(null);
  const [busy, setBusy] = useState<'find' | 'save' | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);
  const finding = useRef(false);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(d => ({ ...d, [key]: value }));
    setProblems(p => ({ ...p, [key]: undefined }));
    if (key !== 'name') setDevices(null);
  }
  function valid(): boolean {
    const p: Problems = {};
    if (!draft.name.trim()) p.name = t.phones.nameProblem;
    if (!machines.some(m => m.id === draft.machineId && m.online)) p.machineId = t.phones.computerProblem;
    if (!PhoneEndpoint.safeParse(draft.endpoint.trim()).success) p.endpoint = t.phones.addressProblem;
    if ((draft.code || draft.pairingAddress) && (!/^\d{6}$/.test(draft.code) || !networkEndpoint(draft.pairingAddress.trim()))) p.code = t.phones.codeProblem;
    setProblems(p);
    const first = Object.keys(p)[0];
    if (first) form.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    return !first;
  }
  const connection = () => ({ machineId: draft.machineId, endpoint: draft.endpoint.trim() });
  const ready = devices?.some(d => d.status === 'device' && d.hardwareKey) ?? false;
  async function find() {
    if (finding.current || !valid()) return;
    finding.current = true; setBusy('find'); setFailure(null); setDevices(null);
    try {
      const reply = await api.post<{ devices: PhoneDevice[] }>('/api/phones/probe', { ...connection(), ...(draft.code ? { pairing: { endpoint: draft.pairingAddress.trim(), code: draft.code } } : {}) });
      setDevices(reply.devices);
      setDraft(d => ({ ...d, pairingAddress: '', code: '' }));
    } catch (error) { setFailure(error); }
    finally { finding.current = false; setBusy(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (finding.current || !valid() || !ready) return;
    finding.current = true; setBusy('save'); setFailure(null);
    try { onAdded(await api.post<PhoneView>('/api/phones', { ...connection(), name: draft.name.trim() })); }
    catch (error) { setFailure(error); }
    finally { finding.current = false; setBusy(null); }
  }
  return <form ref={form} className="phone-form" onSubmit={event => void save(event)} noValidate aria-label={t.phones.add}>
    <fieldset disabled={busy !== null}>
      <legend>{t.phones.add}</legend>
      <Field label={t.phones.name} problem={problems.name}>{props => <input {...props} name="name" autoComplete="off" maxLength={100} value={draft.name} onChange={e => edit('name', e.target.value)} />}</Field>
      <Field label={t.phones.computer} problem={problems.machineId} hint={machines.length === 0 ? t.phones.noComputers : undefined}>{props => <select {...props} name="machineId" value={draft.machineId} onChange={e => edit('machineId', e.target.value)}><option value="">{t.phones.chooseComputer}</option>{machines.map(m => <option key={m.id} value={m.id} disabled={!m.online}>{m.hostname}</option>)}</select>}</Field>
      <Field label={t.phones.address} problem={problems.endpoint} hint={t.phones.networkHint}>{props => <input {...props} name="endpoint" dir="ltr" autoComplete="off" value={draft.endpoint} onChange={e => edit('endpoint', e.target.value)} />}</Field>
      <Field label={t.phones.pairingAddress} hint={t.phones.pairingAddressHint}>{props => <input {...props} name="pairingAddress" dir="ltr" autoComplete="off" value={draft.pairingAddress} onChange={e => edit('pairingAddress', e.target.value)} />}</Field>
      <Field label={t.phones.pairingCode} problem={problems.code} hint={t.phones.pairingHint}>{props => <input {...props} name="code" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={draft.code} onChange={e => edit('code', e.target.value)} />}</Field>
      <div className="entry-actions"><button type="button" className="btn" onClick={() => void find()}>{busy === 'find' ? t.phones.working : t.phones.find}</button></div>
      {devices && <div role="status">{devices.length === 0 ? <p>{t.phones.noDevices}</p> : devices.map(d => <p key={d.serial} className="phone-device">{t.phones.device(d.model, d.serial)}<small>{t.phones.devices[d.status]}</small></p>)}</div>}
    </fieldset>
    {failure !== null && <p role="alert" className="bad">{errorText(t, failure)}</p>}
    <div className="form-foot"><button type="button" className="act" onClick={onCancel} disabled={busy !== null}>{t.phones.cancel}</button>{devices && <button type="submit" className="btn" disabled={!ready || busy !== null}>{busy === 'save' ? t.phones.saving : t.phones.add}</button>}</div>
  </form>;
}

function PhoneCard({ phone, mine, machine, onChanged }: { phone: PhoneView; mine: boolean; machine: string; onChanged: (p: PhoneView) => void }) {
  const t = useT();
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  async function control(action: 'stop' | 'resume') {
    if (busy) return;
    setBusy(true); setFailure(null);
    try { onChanged(await api.post<PhoneView>(`/api/phones/${phone.id}/${action}`)); }
    catch (error) { setFailure(error); }
    finally { setBusy(false); }
  }
  return <CardFrame label={phone.name} head={<CardHead mark={null} name={phone.name} state={t.phones.states[phone.online ? phone.state : 'offline']} line={t.phones.owner(phone.owner.name)} />}>
    <Part title={t.phones.computer}><Facts items={[[t.phones.computer, machine]]} /><p className="muted">{t.phones.waiting(phone.queued)}</p></Part>
    {mine && <Part title={t.phones.control}>
      <div className="entry-actions"><button type="button" className="act" aria-expanded={watching} onClick={() => setWatching(v => !v)}>{watching ? t.phones.hide : t.phones.watch}</button>
        {phone.lending ? <button type="button" className="btn danger" disabled={busy} onClick={() => void control('stop')}>{t.phones.stop}</button> : <button type="button" className="btn" disabled={busy || phone.stopping} onClick={() => void control('resume')}>{t.phones.resume}</button>}
      </div>
      {phone.stopping && <p role="status">{t.phones.stopping}</p>}
      {failure !== null && <p className="bad" role="alert">{errorText(t, failure)}</p>}
      {watching && <PhoneScreen phone={phone} />}
    </Part>}
  </CardFrame>;
}
