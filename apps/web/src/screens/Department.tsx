import type { LineState } from '@hornhoof/protocol/map';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { useStream } from '../live';
import { useDepartmentTree } from '../tasks';
import type { Department, Employee, EmployeeStatus, Me, PersonView } from '../types';
import { Bar, percent } from '../ui/Bar';
import { Chip, agentWorking, doingLine, modelLine, Switch, STATUS_CLASS } from '../ui/Chip';
import { CANVAS_NARROW as NARROW, LEFT_PANEL_COVER, canvasSpace, usePanZoom, ZoomBar } from '../ui/canvas';
import { Edge } from '../ui/Edge';
import { AgentIcon, BackIcon, MapIcon, PersonIcon, ProviderMark, SpeedIcon, TreeIcon } from '../ui/icons';
import { ApprovalPolicy } from '../ui/ApprovalPolicy';
import { PersonButton } from '../ui/PersonButton';
import { Repositories } from '../ui/RepoSettings';
import { DeptBranchesIfKept } from '../ui/DeptBranches';
import { StaffCard } from '../ui/StaffCard';
import { BriefingPanel } from '../ui/Briefing';
import { DeptEmployeeList, DeptSubUnits, employeeGroups } from '../ui/SubUnits';
import { LiveWay, Pulse, motionSpeed, pulseSeconds, toD, useReducedMotion, type Point } from '../ui/wires';
import { useWorkLines } from '../ui/work-lines';
import { AgentState } from '../ui/AgentState';
import { employeeKind, WorkerMark } from '../ui/WorkerMark';
import { OneShotMarks } from '../ui/TaskWorkflow';
import { TreeView } from './TreeView';
import { useOpenAgent } from './AgentWindowContext';
import { SpeedPanel } from './SpeedPanel';
import { arrowD, CY, FT, FW, HH, HW, PH, PW, leadsStage, schemaLayout, stepPaths, type Frame, type Line, type Schema } from './schema';
import { takeEscape } from '../ui/escape';
import { guardedResizeObserver, useRenderGuard } from '../guard';

export { employeeGroups };

const frameTitle = (f: Frame, language: 'en' | 'ru', t: ReturnType<typeof useT>) =>
  f.oneShot ? t.tasks.echelons.stages[f.oneShot.stage] : f.team ? f.team.name : f.role ? f.role.title[language] : t.dept.others;

function frameDescription(role: NonNullable<Frame['role']>, language: 'en' | 'ru', t: ReturnType<typeof useT>): string {
  if (role.schema === 'final_check') return t.dept.finalTurnCheck;
  if (role.schema === 'observer') return t.dept.turnObserver;
  return role.description[language] ?? '';
}

function FrameHeading({ frame: f, language, canGive, calls }: { frame: Frame; language: 'en' | 'ru'; canGive: boolean; calls?: Department['calls'] }) {
  const t = useT();
  return (
    <Edge cut={14} corner>
      <span className={`fh${f.role && canGive ? ' has-sw' : ''}`}>
        <span className="fn">{frameTitle(f, language, t)}</span>
        {f.role && <span className="fa">{frameDescription(f.role, language, t)}</span>}
        {f.oneShot ? <OneShotMarks stage={f.oneShot} calls={calls} /> : <span className="fc">{t.dept.agents(f.members.length)}</span>}
      </span>
    </Edge>
  );
}

type Props = {
  me: Me;
  department: Department;
  /* The people next to the CEO; those whose access lists this department reach it too. */
  deputies: PersonView[];
  selected: string | null;
  /* The panel the schema leaves room for, on its side of the screen. */
  panel: 'window' | 'task' | null;
  /* The server's clock when it read the company, which times the yellow lines. */
  serverNow?: string;
  onBack(): void;
  onHire(): void;
  onOpen(agentId: string): void;
  onOpenTask(taskId: string): void;
  /* A person's card opens the decisions screen showing theirs. */
  onOpenDecisions?(personId: string): void;
  /* Its Tasks button opens the tracker at this department. */
  onOpenTracker?(departmentId: string): void;
  onOpenDepartment?(id: string): void;
};

/* The agent window is on the right, settings and task details on the left. */
const COVER = { window: 688, task: LEFT_PANEL_COVER } as const;
const MIN_K = 0.15, MAX_K = 2;
/* Below this scale the schema shows colors instead of text. */
const FAR_K = 0.55;
/* The schema opens at least this large, from its left edge, when it does not fit the screen. */
const START_K = 0.62;
const PULSE_SPEED = 160;
const FLASH_MS = 1400;

type Shot = { key: number; pts: Point[]; tone: 'c' | 'a' };
type Said = { key: number; at: string; text: string } | null;
type SeenState = { status: EmployeeStatus; taskId: string | null; revision: number };
type Seen = Map<string, SeenState>;

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const taskText = (e: Employee) => (e.task ? `#${e.task.number} ${e.task.title}` : '');

function HeadCard({ d, head, stats, on, flash, serverNow, onOpen, onSwitch }: { d: Department; head: Employee | null; stats: string; on: boolean; flash: boolean; serverNow?: string; onOpen(id: string): void; onSwitch?(on: boolean): void }) {
  const t = useT();
  const { language } = useLanguage();
  const style = { left: 0, top: 0, width: HW, height: HH };
  if (!head)
    return (
      <div className="shead empty" style={style}>
        <Edge cut={14} corner>
          <span className="hr">
            <AgentIcon />
            <span className="role">{`${d.roleCode}, ${deptLabel(t, d)}`}</span>
          </span>
          <span className="hn" dir="auto">{t.dept.noHead}</span>
          <span className="meta" dir="auto">{stats}</span>
        </Edge>
      </div>
    );
  const role = head.title?.[language];
  return (
    <div className={`sslot${head.on ? '' : ' off'}${onSwitch ? ' has-sw' : ''}`} style={style}>
      <button type="button" className={`shead ${STATUS_CLASS[head.status]}${on ? ' on' : ''}${flash ? ' flash' : ''}`} aria-pressed={on} onClick={() => onOpen(head.id)}>
        <Edge cut={14} corner halo>
          <span className="hr">
            <WorkerMark kind={employeeKind(head.turnkey)} />
            <span className="role">{`${d.roleCode}, ${deptLabel(t, d)}`}</span>
            <ProviderMark provider={head.provider} />
          </span>
          <span className="hn">{head.name}</span>
          <span className="meta">{[role && role !== head.name ? role : null, modelLine(t, head)].filter(Boolean).join(', ')}</span>
          <span className="meta" dir="auto">{stats}</span>
          <span className="hx">
            <span className="st">{t.dept.status[head.status]}</span>
            <AgentState agent={agentWorking(head)} serverNow={serverNow} />
            <span className="hx-task">{doingLine(t, head)}</span>
          </span>
          {head.context !== null && (
            <span className="hc">
              <span>{t.dept.context}</span>
              <Bar used={head.context} title={t.dept.contextUsed(percent(head.context))} />
              <b>{percent(head.context)}%</b>
            </span>
          )}
        </Edge>
      </button>
      <Switch e={head} onSwitch={onSwitch} />
    </div>
  );
}

/* Who owns the department and how its approvals go, for people with access to the department itself. */
function DeptApprovals({ department, shown }: { department: Department; shown: boolean }) {
  const t = useT();
  const id = useId();
  if (!shown) return null;
  return (
    <section aria-labelledby={`${id}-approvals`}>
      <h3 id={`${id}-approvals`}>{t.dept.approvals.title}</h3>
      <ApprovalPolicy departmentId={department.id} ownerPersonId={department.ownerPersonId} />
    </section>
  );
}

type Drawer = 'about' | 'speed' | 'hire';

const drawerTitle = (t: ReturnType<typeof useT>, drawer: Drawer | null): string =>
  ({ speed: t.dept.speed, hire: t.dept.hiring, about: t.dept.about })[drawer ?? 'about'];

function Wire({ l }: { l: Line }) {
  const d = toD(l.pts);
  const knock = l.cls === 'pl';
  return (
    <>
      {knock && <path className="ko" d={d} />}
      <path className={l.cls} d={d} />
      {l.arrow && <path className="ah" d={arrowD(l.pts)} />}
    </>
  );
}

/* Live work and results follow the actual employee-to-head connection. */
function MemberLines({ s, toMember, stateOf, still }: { s: Schema; toMember(id: string): Point[] | null; stateOf(up: string, down: string): LineState; still: boolean }) {
  const head = s.head;
  if (!head) return null;
  return s.frames.flatMap(f =>
    f.members.map(m => {
      const state = stateOf(head.id, m.e.id);
      const down = state === 'quiet' ? null : toMember(m.e.id);
      if (!down) return null;
      return <LiveWay key={m.e.id} pts={state === 'yellow' ? [...down].reverse() : down} speed={PULSE_SPEED} tone={state === 'yellow' ? 'a' : 'c'} still={still} data={{ 'data-work': m.e.id }} />;
    }),
  );
}

function DrawerHead({ title, onClose }: { title: string; onClose(): void }) {
  const t = useT();
  return (
    <div className="dv-drawer-h">
      <b>{title}</b>
      <button className="zbtn" type="button" aria-label={t.dept.close} onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

/* Wrapped actions determine the tree's floor and the ticker's remaining room. */
function useDepartmentSpace(language: string, panel: Props['panel']) {
  const root = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ right: 16, bottom: 228, tickerHidden: false });
  useLayoutEffect(() => {
    const el = root.current, acts = actions.current;
    if (!el || !acts) return;
    const measure = () => {
      const phone = window.innerWidth <= NARROW;
      const width = el.clientWidth || window.innerWidth;
      const right = phone ? 16 : acts.offsetWidth + 32;
      const bottom = phone && el.clientHeight ? el.clientHeight - acts.offsetTop + 8 : 228;
      setSpace({ right, bottom, tickerHidden: !phone && width - right - 212 < 220 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'department-actions');
    observer.observe(el);
    observer.observe(acts);
    return () => observer.disconnect();
  }, [language, panel]);
  const style = { '--ticker-right': `${space.right}px`, '--tree-bottom': `${space.bottom}px` } as CSSProperties;
  return { root, actions, style, tickerHidden: space.tickerHidden };
}

/* Inside a department: the head above the current task stages and their owners. Tasks, the repository, products and
   people open in a drawer at the left. */
export function pruneSwitched(switched: Record<string, boolean>, employees: Employee[]): Record<string, boolean> {
  const entries = Object.entries(switched);
  if (!entries.length) return switched;
  const kept = entries.filter(([id, on]) => employees.find(e => e.id === id)?.on !== on);
  return kept.length === entries.length ? switched : Object.fromEntries(kept);
}

export function DepartmentView({ me, department: d, deputies, selected, panel, serverNow, onBack, onHire, onOpen, onOpenTask, onOpenDecisions, onOpenTracker }: Props) {
  useRenderGuard('department');
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const still = useReducedMotion();
  const company = me.person.scopeKind === 'company';
  const reach = [
    ...d.people,
    ...deputies.filter(p => !p.access.whole && (p.access.departments.some(x => x.id === d.id) || p.access.teams.some(x => x.departmentId === d.id))),
  ];
  /* Everyone of the company reads the department's tasks, tree and speed; giving it a task takes the department itself in
     the access, not only a team in it. What it keeps for its agents names its repositories, so it stays with the people
     who reach it. */
  const mine = reach.find(p => p.id === me.person.id);
  const reaches = company || !!mine;
  const canGive = company || !!mine?.access.departments.some(x => x.id === d.id);
  /* Everyone given the department runs it as the whole company does, its named owner among them: its people, sub-units and
     repository. A team in it alone is not the department. */
  const runs = canGive;
  const [tree, setTree] = useState(false);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const { tree: workTree, failure: treeFailure } = useDepartmentTree(d.id, tree || drawer === 'speed');
  const openAgent = useOpenAgent();
  const chrome = useDepartmentSpace(language, panel);
  useEffect(() => {
    if (!drawer) return;
    /* An Escape the task panel over the drawer took closes only that panel. */
    const close = (e: KeyboardEvent) => { if (takeEscape(e)) setDrawer(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawer]);

  const s = useMemo(() => schemaLayout(d, reach.length), [d, reach.length]);
  const paths = useMemo(() => stepPaths(s), [s]);
  const box = useRef<HTMLDivElement>(null);
  const { view, setView, zoomAt, handlers, dragged } = usePanZoom(box, `${d.id}:${tree}`, { min: MIN_K, max: MAX_K });
  const covered = panel ? COVER[panel] : 0;

  /* Opens at a readable size from the left when the schema is wider than the screen; Fit shows all of it. */
  const place = useCallback(
    (whole: boolean) => {
      const el = box.current;
      if (!el || !el.clientWidth) return;
      const { left, width } = canvasSpace(el.clientWidth, panel === 'window' ? 0 : covered, panel === 'window' ? covered : 0);
      const padTop = 76, padBottom = 76, padX = 48;
      const bw = s.right + 80, bh = s.h + 40;
      const fitK = Math.max(MIN_K, Math.min((width - padX * 2) / bw, (el.clientHeight - padTop - padBottom) / bh, 1));
      const k = whole || fitK >= START_K ? fitK : START_K;
      const x = k === fitK ? (width - bw * k) / 2 + 40 * k : padX + 40 * k;
      const y = k === fitK ? padTop + (el.clientHeight - padTop - padBottom - bh * k) / 2 + 20 * k : padTop + 20 * k;
      setView({ k, x: left + x, y, smooth: true });
    },
    [s.right, s.h, covered, panel, setView],
  );

  useEffect(() => {
    place(false);
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = guardedResizeObserver(() => place(false), 'department');
    ro.observe(el);
    return () => ro.disconnect();
  }, [place, tree]);

  /* The line from the head to each employee: blue while it works on the head's task, yellow for five minutes after it gave
     a result back, as the server keeps them. */
  const stateOf = useWorkLines(d.workLines, serverNow);
  const stageOf = (id: string) => s.frames.find(f => f.members.some(m => m.e.id === id))?.stage ?? -1;
  /* A message runs amber up to the head and back from a gate, cyan down and on. */
  const wayTone = (from: string, to: string) => (to === s.head?.id || stageOf(to) < stageOf(from) ? 'a' : 'c');

  /* Real changes only: an employee's chip flashes, a pulse runs where its work went, and the line below says what happened. */
  const seen = useRef<Seen | null>(null);
  const [shots, setShots] = useState<(Shot & { speed: number })[]>([]);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState<Said>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const shotKey = useRef(0);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const x of pending) clearTimeout(x);
      pending.clear();
    };
  }, []);

  const later = useCallback((ms: number, fn: () => void) => {
    const x = setTimeout(() => {
      timers.current.delete(x);
      fn();
    }, ms);
    timers.current.add(x);
  }, []);

  /* Dots that run once, each taken away when it gets there. */
  const shoot = useCallback(
    (fired: Shot[]) => {
      if (!fired.length) return;
      const speed = motionSpeed(PULSE_SPEED, still);
      setShots(x => [...x, ...fired.map(f => ({ ...f, speed }))]);
      for (const f of fired) later(pulseSeconds(f.pts, speed) * 1000, () => setShots(x => x.filter(y => y.key !== f.key)));
    },
    [still, later],
  );

  /* A message between two of its agents runs once along the way it took. */
  useStream(m => {
    if (m.type !== 'pulse' || m.from.kind !== 'agent' || m.to.kind !== 'agent' || m.from.departmentId !== d.id) return;
    const pts = paths.way(m.from.id, m.to.id);
    if (pts) shoot([{ key: ++shotKey.current, pts, tone: wayTone(m.from.id, m.to.id) }]);
  });

  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(d.employees.map(e => [e.id, { status: e.status, taskId: e.task?.id ?? null, revision: e.task?.echelons.revision ?? 0 }]));
    if (!before) return;
    const fired: Shot[] = [];
    const changed: string[] = [];
    let text: string | null = null;
    for (const e of d.employees) {
      const was = before.get(e.id);
      if (!was) continue;
      const taskId = e.task?.id ?? null;
      if (was.status === e.status && was.taskId === taskId && was.revision === (e.task?.echelons.revision ?? 0)) continue;
      changed.push(e.id);
      text = [`${e.name}: ${t.dept.status[e.status]}`, taskText(e)].filter(Boolean).join(', ');
      const pts = e.status === 'handed' ? paths.onward(e.id) : taskId && taskId !== was.taskId ? paths.toMember(e.id) : null;
      if (pts) fired.push({ key: ++shotKey.current, pts, tone: 'c' });
    }
    if (text) setSaid({ key: Date.now(), at: hhmm(new Date()), text });
    if (changed.length) {
      setFlashing(new Set(changed));
      later(FLASH_MS, () => setFlashing(new Set()));
    }
    shoot(fired);
  }, [d.employees, paths, shoot, later, t]);

  /* An employee this person does not open says so on the line below instead of opening a window. */
  function open(agentId: string) {
    if (dragged()) return;
    const closed = d.employees.find(e => e.id === agentId && e.opens === false);
    if (closed) setSaid({ key: Date.now(), at: hhmm(new Date()), text: t.dept.closedAgent(closed.name) });
    else onOpen(agentId);
  }

  function openDecisions(personId: string) {
    if (!dragged()) onOpenDecisions?.(personId);
  }

  /* A switch shows at once and holds until the company says the same; a refusal puts it back and says why. */
  const [switched, setSwitched] = useState<Record<string, boolean>>({});
  useEffect(() => setSwitched(x => pruneSwitched(x, d.employees)), [d.employees]);
  const shown = (e: Employee): Employee => (e.id in switched ? { ...e, on: switched[e.id]! } : e);
  const flip = (e: Employee) => (on: boolean) => {
    setSwitched(x => ({ ...x, [e.id]: on }));
    api.patch(`/api/agents/${e.id}`, { on }).then(
      () => setSaid({ key: Date.now(), at: hhmm(new Date()), text: t.dept.switchedLine(e.name, on) }),
      err => {
        setSwitched(x => Object.fromEntries(Object.entries(x).filter(([id]) => id !== e.id)));
        setSaid({ key: Date.now(), at: hhmm(new Date()), text: errorText(t, err) });
      },
    );
  };

  /* The tick on a role's frame switches all its people at once: a role with nobody on takes no part, and its gate is
     passed by. Each refusal puts that one back. */
  const flipRole = (title: string, members: Employee[]) => (on: boolean) => {
    const changed = members.filter(e => shown(e).on !== on);
    setSwitched(x => ({ ...x, ...Object.fromEntries(changed.map(e => [e.id, on])) }));
    void Promise.allSettled(changed.map(e => api.patch(`/api/agents/${e.id}`, { on }))).then(results => {
      const failed = changed.filter((_, i) => results[i]!.status === 'rejected');
      if (failed.length) setSwitched(x => Object.fromEntries(Object.entries(x).filter(([id]) => !failed.some(e => e.id === id))));
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      setSaid({ key: Date.now(), at: hhmm(new Date()), text: refused ? errorText(t, refused.reason) : t.dept.roleSwitchedLine(title, on) });
    });
  };

  const working = d.employees.filter(e => e.status === 'working').length;
  const stats = t.dept.stats(working, d.employees.length, d.roles.filter(role => role.kind === 'member').length);
  const far = view.k < FAR_K;
  const worldStyle = {
    width: s.right,
    height: s.h,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    transition: still || !view.smooth ? 'none' : 'transform .8s cubic-bezier(.3,.7,.2,1)',
    ['--k' as string]: far ? Math.min(2, Math.max(1, 0.72 / view.k)).toFixed(3) : '1',
  } as CSSProperties;
  const drawerName = drawerTitle(t, drawer);
  const treeButton = tree ? t.dept.mapButton : t.dept.treeButton;
  const lines = (...cls: Line['cls'][]) => s.lines.filter(l => cls.includes(l.cls)).map((l, i) => <Wire key={`${l.cls}${i}`} l={l} />);

  return (
    <div className="dview" ref={chrome.root} style={chrome.style}>
      {tree && (workTree ? (
        <TreeView tree={workTree} department={d} onOpenTask={onOpenTask} />
      ) : <div className="tview"><p className="tv-empty glass">{treeFailure ? errorText(t, treeFailure) : t.common.loading}</p></div>)}
      {!tree && (
      <div className={`dcanvas${far ? ' far' : ''}`} ref={box} role="region" aria-label={t.dept.schema} {...handlers}>
        <div className="world" style={worldStyle}>
          <section aria-labelledby={`${id}-members`} className="slayer">
          <h3 id={`${id}-members`} className="sr">{t.dept.members}</h3>
          {s.frames.map(f => (
            <div key={f.key || 'others'} className={`frame${f.check ? ' gt' : ''}${f.oneShot ? ' frame-calls' : ''}`} role="group" aria-label={frameTitle(f, language, t)} style={{ left: f.x, top: FT, width: FW, height: f.h }}>
              <FrameHeading frame={f} language={language} canGive={canGive} calls={d.calls} />
              {f.role && canGive && (
                <input
                  type="checkbox"
                  className="sw"
                  checked={f.members.some(m => shown(m.e).on)}
                  aria-label={t.dept.roleOn(f.role.title[language])}
                  title={t.dept.roleOn(f.role.title[language])}
                  onPointerDown={ev => ev.stopPropagation()}
                  onChange={ev => flipRole(f.role!.title[language], f.members.map(m => m.e))(ev.target.checked)}
                />
              )}
              <div className="slayer">{f.members.map(m => <Chip key={m.e.id} e={shown(m.e)} x={m.x - f.x} y={m.y - FT} on={selected === m.e.id} lead={leadsStage(m.e)} flash={flashing.has(m.e.id)} serverNow={serverNow} onOpen={() => open(m.e.id)} onSwitch={canGive ? flip(m.e) : undefined} />)}</div>
            </div>
          ))}
          </section>
          <svg className="wires" width={s.right} height={s.h} viewBox={`0 0 ${s.right} ${s.h}`} aria-hidden="true">
            {lines('gate')}
            {lines('tr', 'tick')}
            {s.vias.map(([x, y]) => (
              <circle key={`${x}-${y}`} className="via" cx={x} cy={y} r="4" />
            ))}
            {lines('pl')}
            {s.gates.map(g => (
              <path key={g.x} className="gd" d={`M ${g.x} ${CY - 7} L ${g.x + 7} ${CY} L ${g.x} ${CY + 7} L ${g.x - 7} ${CY} Z`} />
            ))}
            {s.report && <Wire l={{ cls: 'pl', pts: s.report.pts, arrow: true }} />}
            <MemberLines s={s} toMember={paths.toMember} stateOf={stateOf} still={still} />
            {shots.map(x => (
              <Pulse key={x.key} pts={x.pts} speed={x.speed} once tone={x.tone} />
            ))}
          </svg>
          {s.gates.map(g => (
            <span key={g.x} className="gl" style={{ left: g.x, top: CY + 12 }}>
              {t.dept.gate(g.n)}
            </span>
          ))}
          {s.report && (
            <span className="llab" style={{ left: s.report.label[0], top: s.report.label[1] }}>
              {t.dept.reportLine}
            </span>
          )}

          <section aria-labelledby={`${id}-head`} className="slayer" style={{ left: s.hx - HW / 2 }}>
            <h3 id={`${id}-head`} className="sr">
              {t.dept.head}
            </h3>
            <HeadCard
              d={d}
              head={s.head && shown(s.head)}
              stats={stats}
              on={!!s.head && selected === s.head.id}
              flash={!!s.head && flashing.has(s.head.id)}
              serverNow={serverNow}
              onOpen={open}
              onSwitch={s.head && canGive ? flip(s.head) : undefined}
            />
          </section>
          {reach.map((p, k) => (
            <div key={p.id} className="pchip" style={{ left: s.people[k]![0], top: s.people[k]![1], width: PW, height: PH }}>
              <PersonButton person={p} frame={{ w: PW, h: PH, cut: 8 }} onOpen={() => openDecisions(p.id)}>
                <Edge cut={8} halo>
                  <PersonIcon />
                  <span className="pn">
                    <b>{p.name}</b>
                    <span>{p.title || t.dept.leads}</span>
                  </span>
                </Edge>
              </PersonButton>
            </div>
          ))}

        </div>
        {!d.employees.some(e => e.kind !== 'head') && <p className="dv-empty glass" dir="auto">{t.dept.noMembers}</p>}
      </div>

      )}

      <nav className="crumbs" aria-label={deptLabel(t, d)}>
        <button className="hbtn glass ib" type="button" aria-label={t.dept.back} title={t.dept.back} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="crumb glass">
          <h2>{deptLabel(t, d)}</h2>
          <span className="role">{d.roleCode}</span>
        </div>
      </nav>

      <div className="dv-acts" ref={chrome.actions} onPointerDown={e => e.stopPropagation()}>
        <button className="hbtn glass ib" type="button" aria-label={treeButton} title={treeButton} onClick={() => setTree(!tree)}>{tree ? <MapIcon /> : <TreeIcon />}</button>
        <button className={`hbtn glass ib${drawer === 'speed' ? ' on' : ''}`} type="button" aria-label={t.dept.speed} title={t.dept.speed} aria-expanded={drawer === 'speed'} onClick={() => setDrawer(drawer === 'speed' ? null : 'speed')}><SpeedIcon /></button>
        <button className="hbtn glass" type="button" onClick={() => onOpenTracker?.(d.id)}>
          {t.dept.tasksButton}
        </button>
        <button className={`hbtn glass${drawer === 'about' ? ' on' : ''}`} type="button" aria-expanded={drawer === 'about'} onClick={() => setDrawer(drawer === 'about' ? null : 'about')}>
          {t.dept.about}
        </button>
        {/* The orchestrator's window is the whole company's; the owner hires from the roster here. */}
        {runs && (
          <button className="btn" type="button" onClick={company ? onHire : () => setDrawer('hire')}>
            {t.dept.hire}
          </button>
        )}
      </div>

      {drawer && (
        <aside className={`dv-drawer${drawer === 'speed' ? ' spd' : ''}`} aria-label={drawerName}>
          <DrawerHead title={drawerName} onClose={() => setDrawer(null)} />
          {drawer === 'speed' ? (workTree ? <SpeedPanel tree={workTree} department={d} onAgent={openAgent} /> : <div className="dv-drawer-b">{treeFailure ? errorText(t, treeFailure) : t.common.loading}</div>) : (
          <div className="dv-drawer-b">
            {drawer === 'hire' && runs && <StaffCard department={{ id: d.id, name: deptLabel(t, d) }} onDone={() => setDrawer(null)} onHide={() => setDrawer(null)} />}
            {drawer === 'about' && (
              <>
                <DeptEmployeeList department={d} company={runs} />
                <DeptSubUnits department={d} company={runs} />
                <DeptApprovals department={d} shown={canGive} />
                {reaches && (
                  <section aria-labelledby={`${id}-briefing`}>
                    <h3 id={`${id}-briefing`}>{t.briefing.title}</h3>
                    <p className="muted">{t.briefing.intro}</p>
                    <BriefingPanel placeId={d.id} />
                  </section>
                )}
                {runs && <Repositories department={d} />}
                <DeptBranchesIfKept department={d} shown={runs} />
                {d.products.length > 0 && (
                  <section aria-labelledby={`${id}-products`}>
                    <h3 id={`${id}-products`}>{t.dept.products}</h3>
                    <ul className="dv-list">
                      {d.products.map(p => (
                        <li key={p.id}>
                          <b>{p.name}</b>
                          {reaches && (
                            <section className="briefing-product" aria-label={`${t.briefing.title}: ${p.name}`}>
                              <h4>{t.briefing.title}</h4>
                              <BriefingPanel placeId={p.id} />
                            </section>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section aria-labelledby={`${id}-people`}>
                  <h3 id={`${id}-people`}>{t.dept.people}</h3>
                  {reach.length ? (
                    <ul className="dv-list">
                      {reach.map(p => (
                        <li key={p.id}>
                          <b>{p.name}</b>
                          {p.title && <small>{p.title}</small>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{t.dept.noPeople}</p>
                  )}
                </section>
              </>
            )}
          </div>
          )}
        </aside>
      )}

      {!tree && <ZoomBar k={view.k} onZoom={zoomAt} onFit={() => place(true)} />}
      {/* An open panel takes the room the ticker needs. */}
      {!panel && !chrome.tickerHidden && (
        <div className="ticker glass" aria-live="polite" onPointerDown={e => e.stopPropagation()}>
          <span className="live" />
          {said && <span className="tt">{said.at}</span>}
          <span key={said?.key ?? 0} className="tx in" title={said?.text ?? t.dept.hint}>
            {said?.text ?? t.dept.hint}
          </span>
        </div>
      )}
    </div>
  );
}
