import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { NodeLoad } from '@hornhoof/protocol';
import { ApiFailure, api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { BuiltinView, CopiesView, DataView, MachineView, Me, MoveView, SubView, TlsView, Unfit } from '../types';
import { Ask } from '../ui/Ask';
import { Bar, Share } from '../ui/Bar';
import { ActiveCommandPanel, CommandBox, CommandLifetime, hideShownCommand, liveCommand, loadMachineCommands, openCommandIds, toActiveCommand, type ActiveCommand } from '../ui/CommandBox';
import { Edge } from '../ui/Edge';
import { LoadFailure } from '../ui/LoadFailure';
import { doneOf, Idle, useHeldRows, useLoad, type Load } from '../ui/Loading';
import { latestAnswers, useStream } from '../live';
import { CardBlock, CardFrame, CardHead, EmptyBox, Facts, Gauge, MachineMark, Part } from '../ui/Cards';
import { ProviderMark } from '../ui/icons';
import { AgentsCell, agentAmounts, RunningNow } from '../ui/RunningNow';
import { providerFilter, type FilterGroup } from '../ui/TableTools';
import { HeldTable, SortTable, type TableColumn } from '../ui/SortTable';
import type { TableSearch } from '../ui/TableTools';
import { clock, planStateOnMachine, subName } from '../ui/subscription';
import { MachineAccessBlock } from '../ui/MachineAccessBlock';
import { useNow } from '../ui/reset';
import { MachineConnections } from '../ui/MachineConnections';
import { ProgramVersions } from '../ui/ProgramVersions';
import { TickBox } from '../ui/TickBox';
import { DrainLine, DrainMark } from '../ui/MachineDrain';
import { DiskParts, gigabytes, LowDisk, type FolderRow } from '../ui/MachineDisk';
import { RouteUnavailable, unavailableFailure, type CardRoute } from './RouteUnavailable';
import { addablePlans, machinePool, machineRows, type MachineRow } from './machine-rows';
import { everyVisible } from '../guard';
import { Phones } from '../ui/Phones';

const REFRESH_MS = 5000;
/* Docker's system on a Mac keeps a little of what it is given, so only a clear gap says it was set smaller. */
const SMALLER = 1.1;

/* The link's certificate is warned about this long before it ends. */
const CERT_WARNING_MS = 14 * 24 * 3600_000;

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

/* Each node's working folders by the name of the plan it serves, as its card names the plan; none for the machine's own node. */
const folderRows = (t: Messages, row: MachineRow, subs: SubView[]): FolderRow[] =>
  (row.folders ?? []).map(({ plan, bytes }) => {
    const sub = subs.find(s => s.id === plan);
    const provider = row.plans.find(p => p.id === plan)?.provider;
    return { plan: sub ? [subName(t, sub), sub.tier].filter(Boolean).join(' ') : provider ? PROVIDER_NAMES[provider] : null, bytes };
  });

/* The machine's disk by part, while it is on the line and its nodes say it. */
function MachineDisk({ row, subs }: { row: MachineRow; subs: SubView[] }) {
  const t = useT();
  const disk = row.online ? row.load?.disk : undefined;
  return disk ? <DiskParts disk={disk} replicas={row.replicas ?? null} folders={folderRows(t, row, subs)} /> : null;
}

const busyShare = (load: number, cpus: number) => Math.min(100, Math.round((load / Math.max(1, cpus)) * 100));

/* The date the link's certificate ends, when that is near and the machine has not renewed it. */
function endingSoon(tls: TlsView | null, now: number): string | null {
  if (!tls?.expiresAt) return null;
  const ends = Date.parse(tls.expiresAt);
  return ends - now < CERT_WARNING_MS ? tls.expiresAt : null;
}

/* The link's certificate runs out soon: people who see the whole company are told above the list. */
function CertificateWarning({ ends }: { ends: string }) {
  const t = useT();
  const { language } = useLanguage();
  return <p className="alert" role="status">{t.machines.certEnds(new Date(ends).toLocaleDateString(language))}</p>;
}

/* The link's encryption as the server says, only for people who see the whole company; an answer that fails says nothing. */
function useLinkTls(me: Me): TlsView | null {
  const [tls, setTls] = useState<TlsView | null>(null);
  const whole = me.person.scopeKind === 'company';
  useEffect(() => {
    if (!whole) return;
    let live = true;
    api
      .get<{ tls?: TlsView | null }>('/api/link')
      .then(found => live && setTls(found.tls ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [whole]);
  return tls;
}

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
            [t.machines.poolOnline, <bdi>{t.machines.of(online, all)}</bdi>],
            [t.machines.poolCores, cores ? <bdi>{cores}</bdi> : t.machines.unknown],
            [t.machines.poolMemory, loads.length ? <bdi>{t.machines.gbOf(gigabytes(language, sum(l => l.memFree)), gigabytes(language, sum(l => l.memTotal)))}</bdi> : t.machines.unknown],
            [t.machines.poolBusy, cores ? <bdi><Share>{t.machines.percent(busyShare(sum(l => l.load), cores))}</Share></bdi> : t.machines.unknown],
          ]}
        />
      </Edge>
    </section>
  );
}

/* The pool's frame while the machines come: its names at once, idle bars where its figures will stand. */
function HeldPool() {
  const t = useT();
  const idle = <Idle w="6ch" />;
  return (
    <section aria-label={t.machines.pool} aria-busy="true">
      <Edge className="pool" cut={12}>
        <Facts className="pool-facts" items={[[t.machines.poolOnline, idle], [t.machines.poolCores, idle], [t.machines.poolMemory, idle], [t.machines.poolBusy, idle]]} />
      </Edge>
    </section>
  );
}

/* A list with no count kept for the session holds this many machines. */
const HELD_MACHINES = 3;

type BodyProps = {
  me: Me; shown: MachineView[] | null; load: Load; builtin: BuiltinView | null; pool: ReturnType<typeof machinePool>; copies: CopiesView | null;
  held: number; columns: TableColumn<MachineRow>[]; search: TableSearch<MachineRow>; table: ReactNode;
};

/* The machines once they came: the pool, the table or that there are none, where Hornhoof keeps copies, and the phones.
   While they come, the pool's frame and the table are held in their place (style book 1.5, section 4; Design #1656). */
function MachinesBody({ me, shown, load, builtin, pool, copies, held, columns, search, table }: BodyProps) {
  const t = useT();
  if (!shown) return <><HeldPool /><HeldTable load={load} columns={columns} search={search} rows={held} /></>;
  return <>
    <Pool {...pool} />
    {shown.length === 0 && !builtin ? <p className="muted">{t.machines.noMachines}</p> : table}
    {/* Under the table: it comes with the machines, so nothing above them moves when they come. */}
    {copies && <div className="machines-copies"><CopiesLine copies={copies} /></div>}
    <Phones me={me} machines={shown} />
  </>;
}

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
      <Gauge label={t.machines.load} figure={<Share>{t.machines.percent(busy)}</Share>} used={busy / 100} sub={t.cards.ofCores(load.cpus)} />
      <MemoryGauge load={load} less={less} />
      <DiskGauge load={load} />
      <Gauge label={t.machines.processor} figure={load.cpus} unit={` ${t.cards.coresWord(load.cpus)}`} sub={[load.cpuModel, fewer ? t.cards.hostCores(load.hostCpus!) : null].filter(Boolean).join(', ')} />
    </div>
    {(fewer || less) && <p className="machine-note">{row.os === 'darwin' ? t.machines.smallerMac : t.machines.smaller}</p>}
    {load.memoryShort && <p className="machine-note">{t.machines.memoryShort}</p>}
  </>;
}

function MachinePlan({ plan, sub, online, now }: { plan: MachineView['plans'][number]; sub: SubView | undefined; online: boolean; now: number }) {
  const t = useT();
  const { language } = useLanguage();
  const state = planStateOnMachine(t, language, { ...plan, online: online && plan.online }, sub?.limits ?? null, now, sub?.limitsUpdatedAt);
  return <li><ProviderMark provider={plan.provider} /><span className="nm"><b>{sub ? subName(t, sub) : PROVIDER_NAMES[plan.provider]}{sub?.tier && <> <small>{sub.tier}</small></>}</b><small>{[sub?.owner.name, state].filter(Boolean).join(', ')}</small></span></li>;
}

function PlansOnMachine({ row, subs }: { row: MachineRow; subs: SubView[] }) {
  const t = useT();
  const now = useNow();
  if (!row.plans.length) return <p className="part-note">{t.cards.noPlans}</p>;
  return <ul className="plist" aria-label={t.cards.plansOn}>{row.plans.map(plan => <MachinePlan key={plan.id} plan={plan} sub={subs.find(s => s.id === plan.id)} online={row.online} now={now} />)}</ul>;
}

function machineColumns(t: Messages, language: Language, priority: boolean): TableColumn<MachineRow>[] {
  const load = (m: MachineRow) => m.online && m.load ? busyShare(m.load.load, m.load.cpus) : null;
  const place: TableColumn<MachineRow>[] = priority ? [{ key: 'priority', label: t.cards.priority, direction: 1, className: 'k-prio', lead: true, value: placeOf, cell: m => <PriorityCell row={m} /> }] : [];
  return [
    ...place,
    { key: 'name', label: t.tables.machine, direction: 1, value: m => m.hostname, cell: m => <><span className="nm"><b>{m.hostname}</b></span>{m.server && <Leader />}<DrainMark drain={m.drain} /><OffChecks row={m} /><OtherBuild row={m} /><BrowserIssue row={m} /><CheckIssue row={m} /><LowDisk row={m} /></> },
    { key: 'owner', label: t.machines.owner, direction: 1, value: m => m.owner?.name ?? null, cell: m => m.owner?.name },
    { key: 'status', label: t.tables.status, direction: 1, value: m => m.online ? 0 : 1, className: 'k-status', cell: m => m.online ? <span className="status ready">{t.machines.online}</span> : <span className="muted">{lastSeen(t, language, m.lastSeenAt)}</span> },
    { key: 'load', label: t.machines.load, direction: -1, value: load, cell: m => load(m) === null ? t.machines.unknown : <span className="cell-load"><Bar used={load(m)! / 100} /><b><bdi>{t.machines.percent(load(m)!)}</bdi></b></span> },
    { key: 'memory', label: t.tables.freeMemory, direction: -1, value: m => m.online ? m.load?.memFree ?? null : null, cell: m => m.online && m.load ? <bdi>{t.machines.gbOf(gigabytes(language, m.load.memFree), gigabytes(language, m.load.memTotal))}</bdi> : t.machines.unknown },
    { key: 'plans', label: t.tables.plans, direction: -1, value: m => m.plans.length, cell: m => <span className="marks">{m.plans.length ? m.plans.map(p => <span key={p.id} className={!m.online || !p.online || p.status !== 'ready' ? 'dim' : undefined}><ProviderMark provider={p.provider} /></span>) : 0}</span> },
    { key: 'agents', label: t.tables.agents, direction: -1, value: m => agentAmounts(m.running.agents), cell: m => <AgentsCell agents={m.running.agents} /> },
    { key: 'tests', label: t.tables.tests, direction: -1, value: m => m.lendsTests === null ? null : Number(m.lendsTests), cell: m => m.lendsTests === null ? null : m.lendsTests ? t.tables.lent : t.tables.notLent },
  ];
}

function machineFilters(t: Messages): FilterGroup<MachineRow>[] {
  const groups: FilterGroup<MachineRow>[] = [
    providerFilter(t.tables.provider, m => m.plans.map(p => p.provider)),
    { key: 'status', label: t.tables.status, values: m => [m.online ? 'online' : 'offline'], text: value => value === 'online' ? t.machines.online : t.cards.offline },
    { key: 'tests', label: t.tables.testFilters, values: m => m.lendsTests ? ['lent'] : [], text: () => t.tables.lentFilter, single: true },
  ];
  return groups.map(group => ({ ...group, all: t.tables.all }));
}

function machineSearch(t: Messages, language: Language, subs: SubView[], row: MachineRow): string {
  const plans = row.plans.map(p => { const s = subs.find(s => s.id === p.id); return s ? subName(t, s) : PROVIDER_NAMES[p.provider]; });
  return [row.hostname, row.owner?.name, ...plans, ...row.running.agents.flatMap(a => [a.name, a.title?.[language], a.department?.name])].join(' ');
}

/* A machine's place in the order the server passes on in: 1 where the server runs, whatever that machine's own row
   says, and none for a machine that takes no part. */
const placeOf = (row: MachineRow): number | null => (row.server ? 1 : row.data?.number ?? null);

/* Why a machine has no number: left out by its owner, the reason the card gives where there is one, or that it cannot
   take the server. */
function dashWhy(t: Messages, row: MachineRow): string {
  const p = t.machines.priority, unfit = row.data?.unfit ?? null;
  if (row.data?.pin === 'none') return p.out;
  return unfit ? p.unfit.lead(unfitText(t, unfit, row.hostname)) : p.cannot;
}

/* The number in its box, the server's filled; or a dash that says why there is none. */
function PriorityCell({ row }: { row: MachineRow }) {
  const t = useT();
  const number = placeOf(row);
  if (number !== null) return <span className={number === 1 ? 'pn one' : 'pn'} title={!row.server && typeof row.data?.pin === 'number' ? t.machines.priority.why.pinned : undefined}>{number}</span>;
  const why = dashWhy(t, row);
  return <><span className="pdash" title={why} aria-hidden="true" /><span className="sr">{why}</span></>;
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

/* The mark of a machine its owner took back from the company's runs, in its row and its card; the server's own card on
   no machine of the company lends always and has none. */
function OffChecks({ row }: { row: MachineRow }) {
  const t = useT();
  return row.lendsTests === false ? <span className="badge off" title={t.machines.offChecksNote}>{t.machines.offChecks}</span> : null;
}

/* The same in words in its card, for a screen with no pointer to show the mark's title. */
function OffChecksNote({ row }: { row: MachineRow }) {
  const t = useT();
  return row.lendsTests === false ? <p className="machine-note">{t.machines.offChecksNote}</p> : null;
}

function CheckIssue({ row }: { row: MachineRow }) {
  const t = useT();
  return row.checkError ? <span className="badge old" title={row.checkError}>{t.machines.checksPaused}</span> : null;
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
  coreCommands: Record<string, ActiveCommand>;
  makeCore: (machine: MachineView) => unknown;
  cancelCore: (machineId: string, id: string) => unknown;
  confirm: string | null;
  setPicking: (machineId: string | null) => void;
  setConfirm: (id: string | null) => void;
  addPlan: (machine: MachineView, sub: SubView) => unknown;
  cancelAdd: (machineId: string, id: string) => unknown;
  lend: (machine: MachineView, value: boolean) => unknown;
  keepBackups: (machine: MachineView, value: boolean) => unknown;
  disconnect: (machine: MachineView) => unknown;
  refresh: () => Promise<void>;
  fail: (err: unknown) => void;
};

/* What the machine's owner lets the company use it for: its test runs, and, on a machine with the company's core,
   keeping its backups. The owner, or someone who sees the whole company, ticks them; anyone else reads them. */
function OwnerSettings({ machine, editable, onLend, onKeep }: { machine: MachineView; editable: boolean; onLend: (value: boolean) => void; onKeep: (value: boolean) => void }) {
  const t = useT();
  const lends = editable ? (
    <label className="lend">
      <TickBox aria-label={t.machines.lendLabel(machine.hostname)} checked={machine.lendsTests} onChange={e => onLend(e.target.checked)} />
      <span aria-hidden="true">{t.machines.lend}</span>
    </label>
  ) : <span className="muted">{machine.lendsTests ? t.machines.lent : t.machines.notLent}</span>;
  const items: [string, React.ReactNode][] = [[t.tables.tests, lends]];
  if (typeof machine.keepsBackups === 'boolean') {
    const keeps = editable ? (
      <label className="lend">
        <TickBox aria-label={t.machines.keepBackupsLabel(machine.hostname)} checked={machine.keepsBackups} onChange={e => onKeep(e.target.checked)} />
        <span aria-hidden="true">{t.machines.keepBackups}</span>
      </label>
    ) : <span className="muted">{machine.keepsBackups ? t.machines.keepsBackups : t.machines.keepsNoBackups}</span>;
    items.push([t.backups.title, <>{keeps}{(machine.heldBackups ?? 0) > 0 && <> <span className="muted">{t.machines.backupsHeld(machine.heldBackups ?? 0)}</span></>}</>]);
  }
  return <Facts items={items} />;
}

function PlanPicker({ machine, addable, shown, picking, controls }: { machine: MachineView; addable: SubView[]; shown: ActiveCommand | null; picking: boolean; controls: MachineControls }) {
  const t = useT();
  if (shown) return (
    <div className="add-plan">
      <p className="muted">{t.machines.runOn(machine.hostname)}</p>
      <CommandBox command={shown.command} />
      <CommandLifetime expiresAt={shown.expiresAt} />
      <div className="entry-actions"><button className="btn ghost" type="button" onClick={() => controls.cancelAdd(machine.id, shown.id)}>{t.subs.cancelCommand}</button></div>
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

/* The command that brings the company's core to a machine joined before machines had one. */
function CoreCommand({ machine, shown, controls }: { machine: MachineView; shown: ActiveCommand; controls: MachineControls }) {
  const t = useT();
  return (
    <div className="add-plan">
      <p className="muted">{t.machines.coreRun(machine.hostname)}</p>
      <CommandBox command={shown.command} trust={t.machines.trust} />
      <CommandLifetime expiresAt={shown.expiresAt} />
      <div className="entry-actions"><button className="btn ghost" type="button" onClick={() => controls.cancelCore(machine.id, shown.id)}>{t.subs.cancelCommand}</button></div>
    </div>
  );
}

/* A machine that ran Claude keeps a sign-in of Claude's own, which a Disconnect here cannot end. */
const disconnectQuestion = (t: Messages, m: MachineView): string =>
  m.plans.some(plan => plan.provider === 'claude') ? `${t.machines.disconnectAsk(m.hostname)} ${t.machines.disconnectClaude}` : t.machines.disconnectAsk(m.hostname);

/* What the owner can do with the machine: add a plan or bring the core while no command stands open, and disconnect it,
   last. The machine the company was installed on is no computer someone joined: it is not disconnected. */
type OwnerAction = { key: string; text: string; label?: string; danger?: boolean; run: () => unknown };

function ownerActions(t: Messages, m: MachineView, editable: boolean, addable: SubView[], busy: boolean, controls: MachineControls): OwnerAction[] {
  const free: OwnerAction[] = busy ? [] : [
    ...(addable.length ? [{ key: 'add', text: t.machines.addPlan, label: t.machines.addPlanLabel(m.hostname), run: () => controls.setPicking(m.id) }] : []),
    ...(m.needsCore ? [{ key: 'core', text: t.machines.makeCore(m.hostname), run: () => controls.makeCore(m) }] : []),
  ];
  return editable && !m.serverInstall ? [...free, { key: 'off', text: t.machines.disconnect, label: t.machines.disconnectLabel(m.hostname), danger: true, run: () => controls.setConfirm(m.id) }] : free;
}

function OwnerActions({ actions }: { actions: OwnerAction[] }) {
  if (!actions.length) return null;
  return <div className="machine-actions entry-actions">{actions.map(action => <button key={action.key} className={action.danger ? 'act danger' : 'act'} type="button" aria-label={action.label} onClick={action.run}>{action.text}</button>)}</div>;
}

/* The third block: what the owner lets the company use the machine for, then what they can do with it, the question
   before Disconnect standing under the buttons. */
function OwnerBlock({ machine: m, editable, addable, busy, controls }: { machine: MachineView; editable: boolean; addable: SubView[]; busy: boolean; controls: MachineControls }) {
  const t = useT();
  return (
    <CardBlock title={t.cards.ownerBlock}>
      <OwnerSettings machine={m} editable={editable} onLend={value => controls.lend(m, value)} onKeep={value => controls.keepBackups(m, value)} />
      <OwnerActions actions={ownerActions(t, m, editable, addable, busy, controls)} />
      {controls.confirm === m.id && <Ask text={disconnectQuestion(t, m)} yes={t.machines.yesDisconnect} onYes={() => controls.disconnect(m)} onNo={() => controls.setConfirm(null)} />}
    </CardBlock>
  );
}

/* Where the company opens on the machine itself, and on the server's card whom the server could not take. */
function NetworkPlace({ row }: { row: MachineRow }) {
  const t = useT();
  return <>
    {row.refusedBy.map(name => <p key={name} className="machine-note">{t.machines.refuses(row.hostname, name)}</p>)}
  </>;
}

/* Why a machine cannot take the server, in the words of its card. */
function unfitText(t: Messages, unfit: Unfit, host: string): string {
  const u = t.machines.priority.unfit;
  switch (unfit.why) {
    case 'phone': return u.phone;
    case 'no_core': return u.noCore(host);
    case 'scope': return u.scope(unfit.person, unfit.departments);
    case 'no_link': return u.noLink;
  }
}

/* The words for why a machine stands where it does, from the key the ranking stored: a line of its own, or how often
   the machine is online with its strongest or weakest part. A key of a newer server says nothing. */
function whyText(t: Messages, why: string | null): string | null {
  const p = t.machines.priority;
  if (why === null) return null;
  if (why === 'server') return t.cards.serverHere;
  const lines: Record<string, string> = p.why;
  if (lines[why]) return lines[why];
  const [online, part] = why.split('.');
  const often = (p.online as Record<string, string>)[online ?? ''];
  const what = (p.part as Record<string, string>)[part ?? ''];
  return often && what ? p.both(often, what) : often ?? null;
}

function copyText(t: Messages, language: Language, copy: NonNullable<DataView['copy']>): string {
  const c = t.machines.copy;
  switch (copy.line) {
    case 'making': return c.making(copy.progress);
    case 'remaking': return c.remaking(copy.progress);
    case 'saving': return c.saving;
    case 'ready': return c.ready;
    case 'catching_up': return c.catchingUp;
    case 'behind': return c.behind(copy.minutes);
    case 'asleep': return c.asleep(clock(language, copy.since));
    case 'stopped': return copy.why === 'disk_full' ? c.stoppedDiskFull : copy.why === 'setup' ? c.stoppedSetup : c.stopped;
  }
}

type Mode = 'auto' | 'manual' | 'out';

/* The CEO's choice for one machine: left to Hornhoof, a place by hand, or kept from the server. By hand keeps the
   machine at its number, or after the last one when it comes back from out; the list under it gives the places there
   are. While a choice is sent nothing else can be pressed, and a refusal is said under the choices. */
function PriorityChoice({ row, data, last, refresh }: { row: MachineRow; data: DataView; last: number; refresh: () => Promise<void> }) {
  const t = useT();
  const p = t.machines.priority;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const mode: Mode = data.pin === 'none' ? 'out' : data.pin !== null ? 'manual' : 'auto';
  const send = async (pin: DataView['pin']) => {
    setBusy(true);
    setFailure(null);
    try {
      await api.put(`/api/machines/${row.id}/priority`, { pin });
      await refresh();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const pins: Record<Mode, DataView['pin']> = { auto: null, manual: data.number ?? last + 1, out: 'none' };
  const modes: [Mode, string][] = [['auto', p.auto], ['manual', p.manual], ['out', p.out]];
  const places = Array.from({ length: Math.max(last, data.number ?? 0) - 1 }, (_, at) => at + 2);
  return <>
    <span className="pmode" role="radiogroup" aria-label={t.cards.priority}>
      {modes.map(([value, text]) => (
        <label key={value} className="pm-opt">
          <input type="radio" name={`pmode-${row.id}`} checked={mode === value} disabled={busy} onChange={() => void send(pins[value])} />
          <span>{text}</span>
        </label>
      ))}
      {mode === 'manual' && data.number !== null && (
        <select className="sel" aria-label={p.pinLabel(row.hostname)} value={data.number} disabled={busy} onChange={e => void send(Number(e.target.value))}>
          {places.map(place => <option key={place} value={place}>{place}</option>)}
        </select>
      )}
    </span>
    {failure !== null && <p className="alert" role="alert">{failure instanceof ApiFailure && failure.reason === 'only_copy' ? p.onlyCopy(row.hostname) : errorText(t, failure)}</p>}
  </>;
}

/* What the server says of moving it to another machine, and whether this person may ask for that. */
type Moving = { move: MoveView | null; canMove: boolean };

/* The move of the server, on a machine's card. On the machine asked to take it, everyone who sees the part reads how
   far the move is: its copy being made, the server moving, or why it stayed. The CEO may call a move off while the
   copy is made, and may ask a machine that has a number to take the server: the question stands in the button's
   place, the focus on its first answer, and Cancel gives the focus back to the button. While an answer is sent nothing
   can be pressed, and a refusal is said under the buttons. */
function MovePart({ row, data, moving, refresh }: { row: MachineRow; data: DataView; moving: Moving; refresh: () => Promise<void> }) {
  const t = useT();
  const { language } = useLanguage();
  const words = t.machines.move;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const hereButton = useRef<HTMLButtonElement>(null);
  const yesButton = useRef<HTMLButtonElement>(null);
  const backToButton = useRef(false);
  useEffect(() => {
    if (asking) yesButton.current?.focus();
    else if (backToButton.current) hereButton.current?.focus();
    backToButton.current = false;
  }, [asking]);
  const { move, canMove } = moving;
  const target = move?.machine === row.id ? move : null;
  const mayTake = data.number !== null && data.number >= 2 && data.pin !== 'none';
  const offered = canMove && mayTake && move?.state !== 'switching' && (!target || target.state === 'failed');
  const send = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      setAsking(false);
      await refresh();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const said = target
    ? target.state === 'preparing' ? words.waiting(row.hostname, target.progress)
      : target.state === 'switching' ? words.switching(row.hostname)
        : words.failed(target.leader, words.reason[target.reason ?? 'no_answer'](row.hostname))
    : null;
  /* The machine the server last moved from says so once its copy is up to date again, whoever reads the card. */
  const until = data.led ? clock(language, data.led.until) : null;
  const led = until ? words.led(row.hostname, until) : null;
  if (!said && !offered && !led) return null;
  const question = words.ask(row.hostname);
  return <>
    {led && <p>{led}</p>}
    {said && <p>{said}</p>}
    {target?.state === 'preparing' && canMove && <div className="entry-actions"><button className="act" type="button" disabled={busy} onClick={() => void send(() => api.del(`/api/machines/${row.id}/move`))}>{words.stop}</button></div>}
    {offered && !asking && <div className="entry-actions"><button ref={hereButton} className="act" type="button" onClick={() => setAsking(true)}>{words.here}</button></div>}
    {offered && asking && (
      <div className="ask">
        <span className="entry-main">{question}</span>
        <div className="entry-actions" role="group" aria-label={question}>
          <button ref={yesButton} className="btn" type="button" disabled={busy} onClick={() => void send(() => api.post(`/api/machines/${row.id}/move`))}>{words.yes}</button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { backToButton.current = true; setFailure(null); setAsking(false); }}>{words.cancel}</button>
        </div>
      </div>
    )}
    {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
  </>;
}

/* What the server order shows on a card: the number of the machine the server runs on; for the CEO's order, a machine
   that cannot take the server and why, one with a place or kept out, or one the server was asked to move to; nothing
   for a machine with no place. */
type Order = { shown: boolean; last: number; moving: Moving };
type PriorityKind = 'server' | 'unfit' | 'placed' | 'asked' | null;

function priorityKind(row: MachineRow, order: Order): PriorityKind {
  if (!order.shown) return row.source && row.server ? 'server' : null;
  if (placeOf(row) === 1) return 'server';
  return row.data ? placedKind(row.data, order.moving.move?.machine === row.id) : null;
}

function placedKind(data: DataView, asked: boolean): PriorityKind {
  if (data.unfit) return 'unfit';
  if (data.number !== null || data.pin === 'none') return 'placed';
  return asked ? 'asked' : null;
}

/* How the machine's copy of the company's data does, and when it stopped holding the data: in the CEO's order only,
   and not on the machine the server runs on, whose data is the company's own. */
function copyLines(t: Messages, language: Language, row: MachineRow, order: Order): string[] {
  const data = row.data;
  if (!order.shown || !data) return [];
  return [
    data.copy && placeOf(row) !== 1 ? copyText(t, language, data.copy) : null,
    data.leftAt ? t.machines.copy.left(new Date(data.leftAt).toLocaleDateString(language)) : null,
  ].filter((line): line is string => line !== null);
}

/* The Priority part of a card: the machine's number and why it has it, or a dash and why it has none; for the CEO, on
   every machine that may take the server but the one it runs on, the choice of its place and the move of the server.
   last: the highest number there is. */
function PriorityPart({ row, me, order, kind, refresh }: { row: MachineRow; me: Me; order: Order; kind: NonNullable<PriorityKind>; refresh: () => Promise<void> }) {
  const t = useT();
  const p = t.machines.priority;
  /* Number 1 is wherever the server runs, and moves only with the server: nothing to choose there. */
  if (kind === 'server') return <Part title={t.cards.priority}><div className="prio"><span className="prio-n"><span className="pn one">1</span><span>{t.cards.serverHere}</span></span>{order.shown && <small>{p.line}</small>}</div></Part>;
  const data = row.data!;
  const moved = <MovePart row={row} data={data} moving={order.moving} refresh={refresh} />;
  if (kind === 'unfit') return <Part title={t.cards.priority}><div className="prio"><span className="prio-n"><span className="pdash" aria-hidden="true" /><span>{p.unfit.lead(unfitText(t, data.unfit!, row.hostname))}</span></span>{moved}</div></Part>;
  /* A machine with no place says nothing here, unless the server was asked to move to it and stayed. */
  if (kind === 'asked') return <Part title={t.cards.priority}><div className="prio">{moved}</div></Part>;
  const out = data.pin === 'none';
  const why = out ? p.why.out : whyText(t, data.why);
  return (
    <Part title={t.cards.priority}>
      <div className="prio">
        <span className="prio-n">{out ? <span className="pdash" aria-hidden="true" /> : <span className="pn">{data.number}</span>}<span>{why}</span></span>
        {me.person.isOwner && <PriorityChoice row={row} data={data} last={order.last} refresh={refresh} />}
        <small>{p.line}</small>
        {moved}
      </div>
    </Part>
  );
}

/* The first block: what the machine is for the company's server, its place in the order and its copy of the data.
   A machine with no part in either has no such block. */
function ServerBlock({ row, me, order, refresh }: { row: MachineRow; me: Me; order: Order; refresh: () => Promise<void> }) {
  const t = useT();
  const { language } = useLanguage();
  const kind = priorityKind(row, order);
  const copy = copyLines(t, language, row, order);
  if (!kind && !copy.length) return null;
  return (
    <CardBlock title={t.cards.serverBlock}>
      {kind && <PriorityPart row={row} me={me} order={order} kind={kind} refresh={refresh} />}
      {copy.length > 0 && <Part title={t.cards.copyPart}>{copy.map(line => <p key={line}>{line}</p>)}</Part>}
    </CardBlock>
  );
}

/* Who holds the company, under the tab's intro: the leader, the machines that keep a copy and the one that takes over,
   and since when only the leader holds the changes. */
function CopiesLine({ copies }: { copies: CopiesView }) {
  const t = useT();
  const { language } = useLanguage();
  const c = t.machines.copy;
  const names = copies.copies.map(copy => copy.hostname);
  const next = copies.copies.find(copy => copy.sync)?.hostname ?? names[0];
  if (next === undefined) return null;
  const since = clock(language, copies.onlySince);
  return <>
    <p className="muted">{names.length === 1 ? c.one(copies.leader, next) : c.many(copies.leader, new Intl.ListFormat(language, { type: 'conjunction' }).format(names), next)}</p>
    {since && <p className="muted">{c.onlySince(copies.leader, since)}</p>}
  </>;
}

/* The second block: whose machine it is and what system it runs, where the company opens on it, its agent programs
   and its computer access. */
function SystemBlock({ row, editable, controls }: { row: MachineRow; editable: boolean; controls: MachineControls }) {
  const t = useT();
  const m = row.source;
  const openHere: [string, string][] = row.openAt ? [[t.machines.openHere, `localhost:${row.openAt}`]] : [];
  const facts: [string, string][] = m ? [[t.machines.owner, m.owner.name], [t.machines.system, `${SYSTEMS[m.os] ?? m.os}, ${m.arch}`], ...openHere] : openHere;
  return (
    <CardBlock title={t.cards.systemBlock}>
      {facts.length > 0 && <Facts items={facts} />}
      <ProgramVersions id={row.id} online={row.online} programs={row.programs} canUpdate={editable} onUpdated={controls.refresh} />
      {row.access && <MachineAccessBlock view={row.access} onChanged={() => void controls.refresh()} />}
    </CardBlock>
  );
}

function MachineDetails({ row, subs, me, now, order, controls }: { row: MachineRow; subs: SubView[]; me: Me; now: number; order: Order; controls: MachineControls }) {
  const t = useT();
  const { language } = useLanguage();
  const m = row.source;
  const mine = m?.owner.id === me.person.id;
  const editable = me.person.scopeKind === 'company' || mine;
  const addable = addablePlans(m, subs, me.person.id);
  const shown = liveCommand(controls.addCommands[row.id], now);
  const core = liveCommand(controls.coreCommands[row.id], now);
  const picking = controls.picking === row.id;
  return (
    <CardFrame label={row.hostname} accent={row.server}
      head={<CardHead mark={<MachineMark />} name={row.hostname} badges={<>{row.server && <Leader />}<DrainMark drain={row.drain} /><OffChecks row={row} /><OtherBuild row={row} /><BrowserIssue row={row} /><CheckIssue row={row} /><LowDisk row={row} /></>} state={<span className={`status ${row.online ? 'ready' : 'offline'}`}>{row.online ? t.machines.online : t.cards.offline}</span>} line={row.drain ? <DrainLine drain={row.drain} /> : !row.online && lastSeen(t, language, row.lastSeenAt)} />}
      extra={m && (core ? <CoreCommand machine={m} shown={core} controls={controls} /> : <PlanPicker machine={m} addable={addable} shown={shown} picking={picking} controls={controls} />)}>
      <section className="blk blk-facts">
        <h4>{t.cards.aboutMachine}</h4>
        <Part title={t.cards.resources}>
          <Resources row={row} />
          {row.server && <p className="machine-note">{m ? t.machines.builtinHere : t.machines.builtinAbout}</p>}
          <OffChecksNote row={row} />
          <BuildNote row={row} />
          <BrowserNote row={row} />
          {row.checkError && <p className="machine-note">{row.checkError}</p>}
          <NetworkPlace row={row} />
        </Part>
        <MachineDisk row={row} subs={subs} />
      </section>
      <RunningNow title={t.machines.runningNow} label={t.machines.runningOn(row.hostname)} agents={row.running.agents} parts={row.running.parts} online={row.online} me={me} />
      <section className="blk blk-side">
        <h4>{t.cards.plansOn}</h4>
        <PlansOnMachine row={row} subs={subs} />
      </section>
      <div className="mc-blocks">
        <ServerBlock row={row} me={me} order={order} refresh={controls.refresh} />
        <SystemBlock row={row} editable={editable} controls={controls} />
        {m && <OwnerBlock machine={m} editable={editable} addable={addable} busy={Boolean(shown || picking || core)} controls={controls} />}
      </div>
      {m && <MachineConnections key={m.id} id={m.id} hostname={m.hostname} online={row.online} />}
    </CardFrame>
  );
}

export function Machines({ me, selected, onSelect, onHome }: { me: Me } & CardRoute) {
  const t = useT();
  const { language } = useLanguage();
  const now = useNow();
  const certificateEnds = endingSoon(useLinkTls(me), now);
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinView | null>(null);
  const [copies, setCopies] = useState<CopiesView | null>(null);
  /* Whether this person sees the order the server passes on in. */
  const [priority, setPriority] = useState(false);
  const [moving, setMoving] = useState<Moving>({ move: null, canMove: false });
  const [subs, setSubs] = useState<SubView[]>([]);
  const [command, setCommand] = useState<ActiveCommand | null>(null);
  const [addCommands, setAddCommands] = useState<Record<string, ActiveCommand>>({});
  const [coreCommands, setCoreCommands] = useState<Record<string, ActiveCommand>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [askMachines] = useState(latestAnswers);
  const live = useRef(true);
  /* Each change the person makes to the shown commands counts here, so a look that began before it leaves them alone. */
  const commandChanges = useRef(0);
  const commandsChanged = () => {
    commandChanges.current += 1;
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const fresh = askMachines();
    try {
      const [hosts, list] = await Promise.all([
        api.get<{ machines: MachineView[]; builtin?: BuiltinView | null; copies?: CopiesView | null; priority?: boolean; move?: MoveView | null; canMove?: boolean }>('/api/machines'),
        api.get<{ subscriptions: SubView[] }>('/api/subscriptions'),
        loadMachineCommands(live, commandChanges, setCommand, setAddCommands, setCoreCommands),
      ]);
      if (!live.current || !fresh()) return;
      setMachines(hosts.machines);
      setBuiltin(hosts.builtin ?? null);
      setCopies(hosts.copies ?? null);
      setPriority(hosts.priority === true);
      setMoving({ move: hosts.move ?? null, canMove: hosts.canMove === true });
      setSubs(list.subscriptions);
      setLoadFailure(null);
    } catch (err) {
      if (live.current && fresh()) setLoadFailure(err);
    }
  }, [askMachines]);

  /* Machines come online, sign in and take work on their own, so the screen looks again every few seconds, and at once
     after a break, an update among them. */
  useEffect(() => {
    void load();
    return everyVisible(() => void load(), REFRESH_MS);
  }, [load]);
  /* The machines come into their held pool and table, which say why when they do not. */
  const machinesLoad = useLoad([{ data: machines, failure: loadFailure, load }]);
  const shown = doneOf(machines, machinesLoad);
  const heldMachines = useHeldRows('machines', shown ? shown.length : null) ?? HELD_MACHINES;
  useStream(m => {
    if (m.type === 'reconnected') void load();
  });

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
      commandsChanged();
      setCommand(toActiveCommand(res));
    });

  const cancelMachine = (id: string) =>
    run(async () => {
      await hideShownCommand(id);
      commandsChanged();
      setCommand(null);
    });

  const addPlan = (m: MachineView, sub: SubView) =>
    run(async () => {
      const res = await api.post<{ id?: string; command: string; expiresAt?: string }>(`/api/machines/${m.id}/plans`, { subscription: sub.id });
      setPicking(null);
      commandsChanged();
      setAddCommands(all => ({ ...all, [m.id]: toActiveCommand(res) }));
    });

  /* The owner puts the company's core on a machine of theirs that joined before machines had one. */
  const makeCore = (m: MachineView) =>
    run(async () => {
      const res = await api.post<{ id?: string; command: string; expiresAt?: string }>(`/api/machines/${m.id}/core`);
      commandsChanged();
      setCoreCommands(all => ({ ...all, [m.id]: toActiveCommand(res) }));
    });

  const cancelCore = (machineId: string, id: string) =>
    run(async () => {
      await hideShownCommand(id);
      commandsChanged();
      setCoreCommands(all => {
        const next = { ...all };
        delete next[machineId];
        return next;
      });
    });

  const cancelAdd = (machineId: string, id: string) =>
    run(async () => {
      await hideShownCommand(id);
      commandsChanged();
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

  const keepBackups = (m: MachineView, keepsBackups: boolean) =>
    run(async () => {
      await api.patch(`/api/machines/${m.id}`, { keepsBackups });
      setMachines(list => list?.map(x => (x.id === m.id ? { ...x, keepsBackups } : x)) ?? null);
    });

  const disconnect = (m: MachineView) =>
    run(async () => {
      setConfirm(null);
      await api.post(`/api/machines/${m.id}/disconnect`);
      await load();
    });

  const pool = machinePool(machines ?? [], builtin);
  const activeCommand = liveCommand(command, now);
  const openIds = openCommandIds({ ...addCommands, ...coreCommands }, now);
  const rows = machineRows(machines ?? [], builtin, subs, t.machines.builtin);
  const columns = machineColumns(t, language, priority);
  const search: TableSearch<MachineRow> = { placeholder: t.tables.searchMachines, short: t.tables.searchMachinesShort, text: row => machineSearch(t, language, subs, row), count: t.tables.machineCount, room: 'machines' };
  if (unavailableFailure(loadFailure) || unavailableFailure(failure) || (selected && machines && !rows.some(row => row.id === selected))) return <RouteUnavailable onHome={onHome} />;

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
          note={t.machines.firewallNote}
          trust={t.machines.trust}
          shown={activeCommand}
          onCancel={() => void cancelMachine(activeCommand.id)}
        />
      )}
      <LoadFailure failure={machines ? loadFailure : null} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {certificateEnds && <CertificateWarning ends={certificateEnds} />}
      <MachinesBody me={me} shown={shown} load={machinesLoad} builtin={builtin} pool={pool} copies={copies} held={heldMachines} columns={columns} search={search} table={(
        <SortTable
          rows={rows}
          selectedId={selected}
          onSelect={onSelect}
          columns={columns}
          name={row => row.hostname}
          openIds={openIds}
          initialSort={{ key: priority ? 'priority' : 'status', direction: 1 }}
          search={search}
          filters={machineFilters(t)}
          card={row => <MachineDetails row={row} subs={subs} me={me} now={now} order={{ shown: priority, last: Math.max(1, ...rows.map(one => placeOf(one) ?? 0)), moving }} controls={{
            picking, addCommands, coreCommands, confirm, setPicking, setConfirm, addPlan, cancelAdd, makeCore, cancelCore, lend, keepBackups, disconnect, refresh: load, fail: setFailure,
          }} />}
        />
      )} />
    </section>
  );
}
