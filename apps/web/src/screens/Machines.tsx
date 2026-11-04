import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeLoad } from '@hornhoof/protocol';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { BuiltinView, MachineView, Me, Running, SubView } from '../types';
import { Ask } from '../ui/Ask';
import { Bar } from '../ui/Bar';
import { ActiveCommandPanel, CommandBox, CommandLifetime, hideShownCommand, liveCommand, loadMachineCommands, openCommandIds, toActiveCommand, type ActiveCommand } from '../ui/CommandBox';
import { Edge } from '../ui/Edge';
import { CardFrame, CardHead, EmptyBox, Facts, Gauge, MachineMark, Part } from '../ui/Cards';
import { ProviderMark } from '../ui/icons';
import { AgentsCell, agentAmounts, RunningNow } from '../ui/RunningNow';
import { providerFilter, type FilterGroup } from '../ui/TableTools';
import { SortTable, type TableColumn } from '../ui/SortTable';
import { planStateOnMachine, subName } from '../ui/subscription';
import { useNow } from '../ui/reset';
import { ProgramVersions } from '../ui/ProgramVersions';

const REFRESH_MS = 5000;
const GIB = 1024 ** 3;
/* Docker's system on a Mac keeps a little of what it is given, so only a clear gap says it was set smaller. */
const SMALLER = 1.1;

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

const gigabytes = (language: Language, bytes: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.round((bytes / GIB) * 10) / 10);

const busyShare = (load: number, cpus: number) => Math.min(100, Math.round((load / Math.max(1, cpus)) * 100));

function lastSeen(t: Messages, language: Language, iso: string | null): string {
  if (!iso) return t.machines.notSeen;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t.machines.lastSeenNow;
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (s < 3600) return t.machines.lastSeen(rtf.format(-Math.round(s / 60), 'minute'));
  if (s < 86400) return t.machines.lastSeen(rtf.format(-Math.round(s / 3600), 'hour'));
  return t.machines.lastSeen(rtf.format(-Math.round(s / 86400), 'day'));
}

/* The company's machines as one: how many are online, and the processors and memory of those that are. */
function Pool({ loads, online, all }: { loads: NodeLoad[]; online: number; all: number }) {
  const t = useT();
  const { language } = useLanguage();
  const sum = (pick: (l: NodeLoad) => number) => loads.reduce((n, l) => n + pick(l), 0);
  const cores = sum(l => l.cpus);
  return (
    <section aria-label={t.machines.pool}>
      <Edge className="pool" cut={12}>
        <Facts
          className="pool-facts"
          items={[
            [t.machines.poolOnline, t.machines.of(String(online), String(all))],
            [t.machines.poolCores, cores ? String(cores) : t.machines.unknown],
            [t.machines.poolMemory, loads.length ? t.machines.gbOf(gigabytes(language, sum(l => l.memFree)), gigabytes(language, sum(l => l.memTotal))) : t.machines.unknown],
            [t.machines.poolBusy, cores ? `${busyShare(sum(l => l.load), cores)}%` : t.machines.unknown],
          ]}
        />
      </Edge>
    </section>
  );
}

type MachineRow = Omit<MachineView, 'owner' | 'lendsTests'> & {
  owner: MachineView['owner'] | null;
  lendsTests: boolean | null;
  server: boolean;
  source: MachineView | null;
};

function MemoryGauge({ load, less }: { load: NodeLoad; less: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const gb = (bytes: number) => gigabytes(language, bytes);
  const extra = less ? `, ${t.machines.machineHas(gb(load.hostMemory!))}` : '';
  return <Gauge label={t.machines.memory} figure={gb(load.memFree)} unit={t.cards.gbFree} used={load.memTotal > 0 ? 1 - load.memFree / load.memTotal : null} sub={t.cards.ofGb(gb(load.memTotal)) + extra} />;
}

function DiskGauge({ load }: { load: NodeLoad }) {
  const t = useT();
  const { language } = useLanguage();
  if (load.diskFree === undefined || load.diskTotal === undefined) return <Gauge label={t.machines.disk} figure={t.machines.unknown} empty />;
  const used = load.diskTotal > 0 ? 1 - load.diskFree / load.diskTotal : null;
  return <Gauge label={t.machines.disk} figure={gigabytes(language, load.diskFree)} unit={t.cards.gbFree} used={used} sub={t.cards.ofGb(gigabytes(language, load.diskTotal))} />;
}

function Resources({ row }: { row: MachineRow }) {
  const t = useT();
  const load = row.load;
  if (!load) return <EmptyBox title={t.cards.notKnown} />;
  const fewer = load.hostCpus !== undefined && load.hostCpus > load.cpus;
  const less = load.hostMemory !== undefined && load.hostMemory > load.memTotal * SMALLER;
  const busy = busyShare(load.load, load.cpus);
  return <>
    <div className="gauges">
      <Gauge label={t.machines.load} figure={`${busy}%`} used={busy / 100} sub={t.cards.ofCores(load.cpus)} />
      <MemoryGauge load={load} less={less} />
      <DiskGauge load={load} />
      <Gauge label={t.machines.processor} figure={load.cpus} unit={` ${t.cards.coresWord(load.cpus)}`} sub={[load.cpuModel, fewer ? t.cards.hostCores(load.hostCpus!) : null].filter(Boolean).join(', ')} />
    </div>
    {(fewer || less) && <p className="machine-note">{row.os === 'darwin' ? t.machines.smallerMac : t.machines.smaller}</p>}
  </>;
}

function PlansOnMachine({ row, subs }: { row: MachineRow; subs: SubView[] }) {
  const t = useT();
  const { language } = useLanguage();
  const now = useNow();
  if (!row.plans.length) return <p className="part-note">{t.cards.noPlans}</p>;
  return <ul className="plist" aria-label={t.cards.plansOn}>{row.plans.map(plan => {
    const sub = subs.find(s => s.id === plan.id);
    const state = planStateOnMachine(t, language, { ...plan, online: row.online && plan.online }, sub?.limits ?? null, now, sub?.limitsUpdatedAt);
    return <li key={plan.id}><ProviderMark provider={plan.provider} /><span className="nm"><b>{sub ? subName(t, sub) : PROVIDER_NAMES[plan.provider]}{sub?.tier && <> <small>{sub.tier}</small></>}</b><small>{[sub?.owner.name, state].filter(Boolean).join(', ')}</small></span></li>;
  })}</ul>;
}

/* The server merges work in map order; older responses still keep built-in work apart. */
function combinedRunning(machine: Running, builtin: Running): Running {
  const agents = new Map([...machine.agents, ...builtin.agents].map(a => [a.id, a]));
  const parts = new Map([...machine.parts, ...builtin.parts].map(p => [`${p.kind}-${p.run}-${p.part}`, p]));
  return { agents: [...agents.values()], parts: [...parts.values()] };
}

function machineRows(machines: MachineView[], builtin: BuiltinView | null, subs: SubView[], builtinName: string): MachineRow[] {
  const host = builtin?.machine?.id;
  const keys = subs.filter(s => s.kind === 'api_key').map(s => ({ id: s.id, provider: s.provider, status: s.status === 'needs_login' ? 'needs_login' as const : 'ready' as const, online: s.online }));
  const rows = machines.map(m => {
    const here = m.id === host ? builtin : null;
    return { ...m, source: m, server: Boolean(here), online: m.online || Boolean(here?.online), load: m.load ?? here?.load ?? null,
      browserError: m.browserError || here?.browserError || null,
      plans: [...m.plans, ...(here ? keys : [])],
      running: here ? combinedRunning(m.running, here.running) : m.running };
  });
  if (!builtin || machines.some(m => m.id === host)) return rows;
  return [...rows, { id: 'builtin', hostname: builtinName, source: null, server: true, owner: null, lendsTests: null, os: 'linux', arch: '', online: builtin.online, lastSeenAt: null, plans: keys, load: builtin.load, running: builtin.running, programs: builtin.programs, browserError: builtin.browserError || null }];
}

function machineColumns(t: Messages, language: Language): TableColumn<MachineRow>[] {
  const load = (m: MachineRow) => m.online && m.load ? busyShare(m.load.load, m.load.cpus) : null;
  return [
    { key: 'name', label: t.tables.machine, direction: 1, value: m => m.hostname, cell: m => <><span className="nm"><b>{m.hostname}</b></span>{m.server && <Leader />}<OtherBuild row={m} /><BrowserIssue row={m} /></> },
    { key: 'owner', label: t.machines.owner, direction: 1, value: m => m.owner?.name ?? null, cell: m => m.owner?.name },
    { key: 'status', label: t.tables.status, direction: 1, value: m => m.online ? 0 : 1, className: 'k-status', cell: m => m.online ? <span className="status ready">{t.machines.online}</span> : <span className="muted">{lastSeen(t, language, m.lastSeenAt)}</span> },
    { key: 'load', label: t.machines.load, direction: -1, value: load, cell: m => load(m) === null ? t.machines.unknown : <span className="cell-load"><Bar used={load(m)! / 100} /><b>{load(m)}%</b></span> },
    { key: 'memory', label: t.tables.freeMemory, direction: -1, value: m => m.online ? m.load?.memFree ?? null : null, cell: m => m.online && m.load ? t.machines.gbOf(gigabytes(language, m.load.memFree), gigabytes(language, m.load.memTotal)) : t.machines.unknown },
    { key: 'plans', label: t.tables.plans, direction: -1, value: m => m.plans.length, cell: m => <span className="marks">{m.plans.length ? m.plans.map(p => <span key={p.id} className={!m.online || !p.online || p.status !== 'ready' ? 'dim' : undefined}><ProviderMark provider={p.provider} /></span>) : 0}</span> },
    { key: 'agents', label: t.tables.agents, direction: -1, value: m => agentAmounts(m.running.agents), cell: m => <AgentsCell agents={m.running.agents} /> },
    { key: 'tests', label: t.tables.tests, direction: -1, value: m => m.lendsTests === null ? null : Number(m.lendsTests), cell: m => m.lendsTests === null ? null : m.lendsTests ? t.tables.lent : t.tables.notLent },
  ];
}

function machineFilters(t: Messages): FilterGroup<MachineRow>[] {
  return [
    providerFilter(t.tables.provider, m => m.plans.map(p => p.provider)),
    { key: 'status', label: t.tables.status, values: m => [m.online ? 'online' : 'offline'], text: value => value === 'online' ? t.machines.online : t.cards.offline },
    { key: 'tests', label: t.tables.testFilters, values: m => m.lendsTests ? ['lent'] : [], text: () => t.tables.lentFilter, single: true },
  ];
}

function machineSearch(t: Messages, language: Language, subs: SubView[], row: MachineRow): string {
  const plans = row.plans.map(p => { const s = subs.find(s => s.id === p.id); return s ? subName(t, s) : PROVIDER_NAMES[p.provider]; });
  return [row.hostname, row.owner?.name, ...plans, ...row.running.agents.flatMap(a => [a.name, a.title?.[language], a.department?.name])].join(' ');
}

/* The machine the company's server runs on now. */
function Leader() {
  const t = useT();
  return <span className="badge lead" title={t.machines.leaderAbout}>{t.machines.leader}</span>;
}

/* Why a machine's nodes are not the server's build: their builds, by the short commit, and the server's. */
function buildNote(t: Messages, other: NonNullable<MachineView['otherBuild']>): string {
  const short = (build: string | null) => build?.slice(0, 7) ?? t.machines.olderBuild;
  return t.machines.otherBuildNote(other.nodes.map(short).join(', '), short(other.server));
}

/* The mark of a machine whose nodes are not the server's build, in its row and its card. */
function OtherBuild({ row }: { row: MachineRow }) {
  const t = useT();
  return row.otherBuild ? <span className="badge old" title={buildNote(t, row.otherBuild)}>{t.machines.otherBuild}</span> : null;
}

/* The same in words in its card, for a screen with no pointer to show the mark's title. */
function BuildNote({ row }: { row: MachineRow }) {
  const t = useT();
  return row.otherBuild ? <p className="machine-note">{buildNote(t, row.otherBuild)}</p> : null;
}

function BrowserIssue({ row }: { row: MachineRow }) {
  const t = useT();
  return row.browserError ? <span className="badge old" title={t.machines.browserFailedNote(row.browserError)}>{t.machines.browserFailed}</span> : null;
}

function BrowserNote({ row }: { row: MachineRow }) {
  const t = useT();
  return row.browserError ? <p className="machine-note">{t.machines.browserFailedNote(row.browserError)}</p> : null;
}

type MachineControls = {
  picking: string | null;
  addCommands: Record<string, ActiveCommand>;
  confirm: string | null;
  setPicking: (machineId: string | null) => void;
  setConfirm: (id: string | null) => void;
  addPlan: (machine: MachineView, sub: SubView) => unknown;
  cancelAdd: (machineId: string, id: string) => unknown;
  lend: (machine: MachineView, value: boolean) => unknown;
  disconnect: (machine: MachineView) => unknown;
  refresh: () => Promise<void>;
};

function LendSetting({ machine, editable, onChange }: { machine: MachineView; editable: boolean; onChange: (value: boolean) => void }) {
  const t = useT();
  const value = editable ? (
    <label className="lend">
      <input type="checkbox" aria-label={t.machines.lendLabel(machine.hostname)} checked={machine.lendsTests} onChange={e => onChange(e.target.checked)} />
      <span aria-hidden="true">{t.machines.lend}</span>
    </label>
  ) : <span className="muted">{machine.lendsTests ? t.machines.lent : t.machines.notLent}</span>;
  return <Part title={t.tables.settings}><Facts items={[[t.tables.tests, value]]} /></Part>;
}

function PlanPicker({ machine, addable, shown, picking, controls }: { machine: MachineView; addable: SubView[]; shown: ActiveCommand | null; picking: boolean; controls: MachineControls }) {
  const t = useT();
  if (shown) return (
    <div className="add-plan">
      <p className="muted">{t.machines.runOn(machine.hostname)}</p>
      <CommandBox command={shown.command} />
      <CommandLifetime expiresAt={shown.expiresAt} />
      <div className="actions"><button className="btn small ghost" type="button" onClick={() => controls.cancelAdd(machine.id, shown.id)}>{t.subs.cancelCommand}</button></div>
    </div>
  );
  if (!picking) return null;
  return (
    <div className="ask">
      <span>{t.machines.addPlanAsk(machine.hostname)}</span>
      {addable.map(s => <button key={s.id} className="btn small" type="button" aria-label={t.machines.addPlanTo(subName(t, s), machine.hostname)} onClick={() => controls.addPlan(machine, s)}>{subName(t, s)}</button>)}
      <button className="btn small ghost" type="button" onClick={() => controls.setPicking(null)}>{t.common.cancel}</button>
    </div>
  );
}

function MachineSettings({ machine: m, editable, addable, busy, controls }: { machine: MachineView; editable: boolean; addable: SubView[]; busy: boolean; controls: MachineControls }) {
  const t = useT();
  return <>
    <LendSetting machine={m} editable={editable} onChange={value => controls.lend(m, value)} />
    <div className="machine-actions">
      {addable.length > 0 && !busy && <button className="act" type="button" aria-label={t.machines.addPlanLabel(m.hostname)} onClick={() => controls.setPicking(m.id)}>{t.machines.addPlan}</button>}
      {editable && <button className="act danger" type="button" aria-label={t.machines.disconnectLabel(m.hostname)} onClick={() => controls.setConfirm(m.id)}>{t.machines.disconnect}</button>}
    </div>
    {controls.confirm === m.id && <Ask text={t.machines.disconnectAsk(m.hostname)} yes={t.machines.yesDisconnect} onYes={() => controls.disconnect(m)} onNo={() => controls.setConfirm(null)} />}
  </>;
}

function MachineDetails({ row, subs, me, now, controls }: { row: MachineRow; subs: SubView[]; me: Me; now: number; controls: MachineControls }) {
  const t = useT();
  const { language } = useLanguage();
  const m = row.source;
  const mine = m?.owner.id === me.person.id;
  const editable = me.person.scopeKind === 'company' || mine;
  const addable = m && mine ? subs.filter(s => s.kind === 'personal' && s.owner.id === me.person.id && !m.plans.some(p => p.id === s.id)) : [];
  const shown = liveCommand(controls.addCommands[row.id], now);
  const picking = controls.picking === row.id;
  return (
    <CardFrame label={row.hostname} accent={row.server}
      head={<CardHead mark={<MachineMark />} name={row.hostname} badges={<>{row.server && <Leader />}<OtherBuild row={row} /><BrowserIssue row={row} /></>} state={<span className={`status ${row.online ? 'ready' : 'offline'}`}>{row.online ? t.machines.online : t.cards.offline}</span>} line={!row.online && lastSeen(t, language, row.lastSeenAt)} />}
      extra={m && <PlanPicker machine={m} addable={addable} shown={shown} picking={picking} controls={controls} />}>
      <section className="blk blk-facts">
        <h4>{t.cards.aboutMachine}</h4>
        <Part title={t.cards.resources}>
          <Resources row={row} />
          {row.server && <p className="machine-note">{m ? t.machines.builtinHere : t.machines.builtinAbout}</p>}
          <BuildNote row={row} />
          <BrowserNote row={row} />
        </Part>
        {m && <Part title={t.cards.ownerSystem}><Facts items={[[t.machines.owner, m.owner.name], [t.machines.system, `${SYSTEMS[m.os] ?? m.os}, ${m.arch}`]]} /></Part>}
        {m && row.server && <Part title={t.cards.priority}><p className="server-priority"><b>1</b><span>{t.cards.serverHere}</span></p></Part>}
        <ProgramVersions id={row.id} online={row.online} programs={row.programs} canUpdate={editable} onUpdated={controls.refresh} />
      </section>
      <RunningNow title={t.machines.runningNow} label={t.machines.runningOn(row.hostname)} agents={row.running.agents} parts={row.running.parts} online={row.online} me={me} />
      <section className="blk blk-side">
        <h4>{t.cards.plansOn}</h4>
        <PlansOnMachine row={row} subs={subs} />
        {m && <MachineSettings machine={m} editable={editable} addable={addable} busy={Boolean(shown || picking)} controls={controls} />}
      </section>
    </CardFrame>
  );
}

export function Machines({ me }: { me: Me }) {
  const t = useT();
  const { language } = useLanguage();
  const now = useNow();
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinView | null>(null);
  const [subs, setSubs] = useState<SubView[]>([]);
  const [command, setCommand] = useState<ActiveCommand | null>(null);
  const [addCommands, setAddCommands] = useState<Record<string, ActiveCommand>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [hosts, list] = await Promise.all([
        api.get<{ machines: MachineView[]; builtin?: BuiltinView | null }>('/api/machines'),
        api.get<{ subscriptions: SubView[] }>('/api/subscriptions'),
        loadMachineCommands(live, setCommand, setAddCommands),
      ]);
      if (!live.current) return;
      setMachines(hosts.machines);
      setBuiltin(hosts.builtin ?? null);
      setSubs(list.subscriptions);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  /* Machines come online, sign in and take work on their own, so the screen looks again every few seconds. */
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function run(action: () => Promise<void>) {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(err);
    }
  }

  const machineCommand = () =>
    run(async () => {
      const res = await api.post<{ id?: string; command: string; expiresAt?: string }>('/api/machines/command');
      setCommand(toActiveCommand(res));
    });

  const cancelMachine = (id: string) =>
    run(async () => {
      await hideShownCommand(id);
      setCommand(null);
    });

  const addPlan = (m: MachineView, sub: SubView) =>
    run(async () => {
      const res = await api.post<{ id?: string; command: string; expiresAt?: string }>(`/api/machines/${m.id}/plans`, { subscription: sub.id });
      setPicking(null);
      setAddCommands(all => ({ ...all, [m.id]: toActiveCommand(res) }));
    });

  const cancelAdd = (machineId: string, id: string) =>
    run(async () => {
      await hideShownCommand(id);
      setAddCommands(all => {
        const next = { ...all };
        delete next[machineId];
        return next;
      });
    });

  const lend = (m: MachineView, lendsTests: boolean) =>
    run(async () => {
      await api.patch(`/api/machines/${m.id}`, { lendsTests });
      setMachines(list => list?.map(x => (x.id === m.id ? { ...x, lendsTests } : x)) ?? null);
    });

  const disconnect = (m: MachineView) =>
    run(async () => {
      setConfirm(null);
      await api.post(`/api/machines/${m.id}/disconnect`);
      await load();
    });

  /* The built-in node on a machine that joined runs on that machine's computer, which the pool counts once and the list
     shows as one card: online while either is, with what either says it has and what runs on either. */
  const host = builtin?.machine ? ((machines ?? []).find(m => m.id === builtin.machine!.id) ?? null) : null;
  const apart = host ? null : builtin;
  const loads = [...(machines ?? []).map(m => (m === host ? (m.load ?? builtin!.load) : m.load)), apart?.load ?? null].filter((l): l is NodeLoad => l !== null);
  const online = (machines ?? []).filter(m => m.online || (m === host && builtin!.online)).length + (apart?.online ? 1 : 0);
  const activeCommand = liveCommand(command, now);
  const openIds = openCommandIds(addCommands, now);

  return (
    <section className="people machines">
      <header className="people-head">
        <div>
          <h1>{t.machines.heading}</h1>
          <p className="muted">{t.machines.intro}</p>
        </div>
        {!activeCommand && (
          <div className="head-actions">
            <button className="btn" type="button" onClick={() => void machineCommand()}>{t.machines.connect}</button>
          </div>
        )}
      </header>

      {activeCommand && (
        <ActiveCommandPanel
          heading={t.machines.connectHeading}
          run={t.machines.runThis}
          trust={t.machines.trust}
          shown={activeCommand}
          onCancel={() => void cancelMachine(activeCommand.id)}
        />
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {machines && <Pool loads={loads} online={online} all={machines.length + (apart ? 1 : 0)} />}
      {machines && machines.length === 0 && !builtin && <p className="muted">{t.machines.noMachines}</p>}
      {machines && (machines.length > 0 || builtin) && (
        <SortTable
          rows={machineRows(machines, builtin, subs, t.machines.builtin)}
          columns={machineColumns(t, language)}
          name={row => row.hostname}
          openIds={openIds}
          initialSort={{ key: 'status', direction: 1 }}
          search={{ placeholder: t.tables.searchMachines, text: row => machineSearch(t, language, subs, row), count: t.tables.machineCount }}
          filters={machineFilters(t)}
          card={row => <MachineDetails row={row} subs={subs} me={me} now={now} controls={{
            picking, addCommands, confirm, setPicking, setConfirm, addPlan, cancelAdd, lend, disconnect, refresh: load,
          }} />}
        />
      )}
    </section>
  );
}
