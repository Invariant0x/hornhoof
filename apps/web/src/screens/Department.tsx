import type { LineState } from '@hornhoof/protocol/map';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import { useStream } from '../live';
import { useDepartmentTree, useTasks } from '../tasks';
import type { Department, Employee, EmployeeStatus, Me, PersonView } from '../types';
import { Bar, percent } from '../ui/Bar';
import { usePanZoom, ZoomBar } from '../ui/canvas';
import { Edge } from '../ui/Edge';
import { AgentIcon, MapIcon, PersonIcon, ProviderMark, SpeedIcon, TreeIcon } from '../ui/icons';
import { NewTask } from '../ui/NewTask';
import { PersonButton } from '../ui/PersonButton';
import { RepoSettings } from '../ui/RepoSettings';
import { byState, TaskRow } from '../ui/TaskRow';
import { LiveWay, Pulse, pulseSeconds, toD, useReducedMotion, type Point } from '../ui/wires';
import { useWorkLines } from '../ui/work-lines';
import { useRework } from '../ui/use-rework';
import { TreeView } from './TreeView';
import { SpeedPanel } from './SpeedPanel';
import { arrowD, CH, CW, CY, FT, FW, HH, HW, PH, PW, schemaLayout, stepPaths, type Line, type Schema } from './schema';

type Props = {
  me: Me;
  department: Department;
  /* The people next to the CEO; those whose access lists this department reach it too. */
  deputies: PersonView[];
  selected: string | null;
  selectedTask: string | null;
  /* What covers the right of the screen, so the schema starts clear of it. */
  panel: 'window' | 'card' | 'task' | null;
  /* The server's clock when it read the company, which times the yellow lines. */
  serverNow?: string;
  onBack(): void;
  onHire(): void;
  onOpen(agentId: string): void;
  onOpenTask(taskId: string): void;
  /* A person's card opens the decisions screen showing theirs. */
  onOpenDecisions?(personId: string): void;
};

/* The orchestrator's window and the right panels, with their margins. */
const COVER = { window: 688, card: 492, task: 492 } as const;
const NARROW = 760;
const MIN_K = 0.15, MAX_K = 2;
/* Below this scale the schema shows colors instead of text, as in the prototype. */
const FAR_K = 0.55;
/* The schema opens at least this large, from its left edge, when it does not fit the screen. */
const START_K = 0.62;
const PULSE_SPEED = 160;
const FLASH_MS = 1400;

const STATUS_CLASS: Record<EmployeeStatus, string> = { working: 's-w', queued: 's-q', handed: 's-r', waiting: 's-h', idle: 's-i', off: 's-o' };

type Shot = { key: number; pts: Point[]; tone: 'c' | 'a' };
type Said = { key: number; at: string; text: string } | null;
type Seen = Map<string, { status: EmployeeStatus; taskId: string | null; bounces: number }>;

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const taskText = (e: Employee) => (e.task ? `#${e.task.number} ${e.task.title}` : '');

function modelLine(t: ReturnType<typeof useT>, e: Employee): string {
  /* Hornhoof names the level whenever it knows it, the Default's too; else it says the program picks it. */
  const effort = e.effort ? t.agent.effortLine(t.agent.efforts[e.effort] ?? e.effort) : e.provider && t.agent.effortDefault;
  return [e.modelName || e.model || t.agent.default, effort, e.provider && PROVIDER_NAMES[e.provider]].filter(Boolean).join(', ');
}

/* What an employee's third line says: its task, or why it has none. */
function doingLine(t: ReturnType<typeof useT>, e: Employee): string {
  if (e.task) return taskText(e);
  if (!e.on) return t.dept.switchedOff;
  if (e.status === 'off') return t.dept.needsSubscription;
  if (e.timer && e.status === 'idle') return t.dept.onTimer(t.agent.every(e.timer));
  return e.status === 'idle' ? t.dept.waitsForTask : '';
}

/* The tick that switches an agent off for now and on again; it sits beside the chip's button, not inside it. */
function Switch({ e, onSwitch }: { e: Employee; onSwitch?(on: boolean): void }) {
  const t = useT();
  if (!onSwitch) return null;
  return (
    <input
      type="checkbox"
      className="sw"
      checked={e.on}
      aria-label={t.dept.isOn(e.name)}
      title={t.dept.isOn(e.name)}
      onPointerDown={ev => ev.stopPropagation()}
      onChange={ev => onSwitch(ev.target.checked)}
    />
  );
}

function Chip({ e, x, y, on, flash, onOpen, onSwitch }: { e: Employee; x: number; y: number; on: boolean; flash: boolean; onOpen(): void; onSwitch?(on: boolean): void }) {
  const t = useT();
  return (
    <div className={`sslot${e.on ? '' : ' off'}${onSwitch ? ' has-sw' : ''}`} style={{ left: x, top: y, width: CW, height: CH }}>
      <button
        type="button"
        className={`schip ${STATUS_CLASS[e.status]}${on ? ' on' : ''}${flash ? ' flash' : ''}`}
        aria-pressed={on}
        onClick={onOpen}
      >
        <Edge cut={10}>
          <span className="r1">
            <AgentIcon />
            <span className="mn">{e.name}</span>
            <ProviderMark provider={e.provider} />
            <span className="st" title={t.dept.status[e.status]}>{t.dept.status[e.status]}</span>
          </span>
          <span className="r2">{modelLine(t, e)}</span>
          <span className="r3">{doingLine(t, e)}</span>
          {e.context !== null && <Bar used={e.context} className="cx" title={t.dept.contextUsed(percent(e.context))} />}
        </Edge>
      </button>
      <Switch e={e} onSwitch={onSwitch} />
    </div>
  );
}

function HeadCard({ d, head, stats, on, flash, onOpen, onSwitch }: { d: Department; head: Employee | null; stats: string; on: boolean; flash: boolean; onOpen(id: string): void; onSwitch?(on: boolean): void }) {
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
          <span className="hn">{t.dept.noHead}</span>
          <span className="meta">{stats}</span>
        </Edge>
      </div>
    );
  const role = head.title?.[language];
  return (
    <div className={`sslot${head.on ? '' : ' off'}${onSwitch ? ' has-sw' : ''}`} style={style}>
      <button type="button" className={`shead ${STATUS_CLASS[head.status]}${on ? ' on' : ''}${flash ? ' flash' : ''}`} aria-pressed={on} onClick={() => onOpen(head.id)}>
        <Edge cut={14} corner>
          <span className="hr">
            <AgentIcon />
            <span className="role">{`${d.roleCode}, ${deptLabel(t, d)}`}</span>
            <ProviderMark provider={head.provider} />
          </span>
          <span className="hn">{head.name}</span>
          <span className="meta">{[role && role !== head.name ? role : null, modelLine(t, head)].filter(Boolean).join(', ')}</span>
          <span className="meta">{stats}</span>
          <span className="hx">
            <span className="st">{t.dept.status[head.status]}</span>
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

function Wire({ l }: { l: Line }) {
  const d = toD(l.pts);
  const knock = l.cls === 'pl' || l.cls === 'rl';
  return (
    <>
      {knock && <path className="ko" d={d} />}
      <path className={l.cls} d={d} />
      {l.arrow && <path className={l.cls === 'rl' ? 'rah' : 'ah'} d={arrowD(l.pts)} />}
    </>
  );
}

/* The way from the head's card to each employee's runs while the employee works on the head's task, down to the employee,
   and for five minutes after it gave a result back, up to the head. */
function MemberLines({ s, toMember, stateOf, still }: { s: Schema; toMember(id: string): Point[] | null; stateOf(up: string, down: string): LineState; still: boolean }) {
  const head = s.head;
  if (!head) return null;
  return s.frames.flatMap(f =>
    f.members.map(m => {
      const state = stateOf(head.id, m.e.id);
      const down = state === 'quiet' ? null : toMember(m.e.id);
      if (!down) return null;
      const back = state === 'yellow';
      return <LiveWay key={m.e.id} pts={back ? [...down].reverse() : down} speed={PULSE_SPEED} tone={back ? 'a' : 'c'} still={still} data={{ 'data-work': m.e.id }} />;
    }),
  );
}

/* The department's open tasks, and a new one for its head from people whose access lists the department. */
function DeptTasks({ department: d, head, canGive, selected, onOpenTask }: { department: Department; head: Employee | undefined; canGive: boolean; selected: string | null; onOpenTask(id: string): void }) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const { tasks, failure, load } = useTasks({ status: 'open', department: d.id });
  const [writing, setWriting] = useState(false);

  return (
    <section aria-labelledby={`${id}-tasks`}>
      <div className="dv-h">
        <h3 id={`${id}-tasks`} className="sr">
          {t.dept.tasks}
        </h3>
        {canGive && head && !writing && (
          <button className="btn small ghost" type="button" onClick={() => setWriting(true)}>
            {t.dept.newTask}
          </button>
        )}
      </div>
      {canGive && !head && <p className="muted">{t.dept.needsHead}</p>}
      {writing && head && (
        <NewTask
          department={d}
          head={head.title?.[language] === head.name ? null : head.name}
          onCancel={() => setWriting(false)}
          onCreated={task => {
            setWriting(false);
            load();
            onOpenTask(task.id);
          }}
        />
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {tasks && !tasks.length && <p className="muted">{t.dept.noTasks}</p>}
      {tasks && tasks.length > 0 && (
        <ul className="dv-tasks">
          {[...tasks].sort(byState).map(task => (
            <li key={task.id}>
              <TaskRow task={task} on={selected === task.id} place={task.product?.name ?? ''} onOpen={onOpenTask} />
            </li>
          ))}
        </ul>
      )}
    </section>
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
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(acts);
    return () => observer.disconnect();
  }, [language, panel]);
  const style = { '--ticker-right': `${space.right}px`, '--tree-bottom': `${space.bottom}px` } as CSSProperties;
  return { root, actions, style, tickerHidden: space.tickerHidden };
}

/* Inside a department: its schema as in the prototype. The head on top, a frame per role in stages left to right through
   the gates, and the way back from them. Tasks, the repository, products and people open in a drawer at the left. */
export function DepartmentView({ me, department: d, deputies, selected, selectedTask, panel, serverNow, onBack, onHire, onOpen, onOpenTask, onOpenDecisions }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const still = useReducedMotion();
  const company = me.person.scopeKind === 'company';
  const head = d.employees.find(e => e.kind === 'head');
  const reach = [
    ...d.people,
    ...deputies.filter(p => !p.access.whole && (p.access.departments.some(x => x.id === d.id) || p.access.teams.some(x => x.departmentId === d.id))),
  ];
  /* Tasks are for people who reach the department; giving it one takes the department itself in the access, not only a team in it. */
  const mine = reach.find(p => p.id === me.person.id);
  const sees = company || !!mine;
  const canGive = company || !!mine?.access.departments.some(x => x.id === d.id);
  const [tree, setTree] = useState(false);
  const [drawer, setDrawer] = useState<'tasks' | 'about' | 'speed' | null>(null);
  const { tree: workTree, failure: treeFailure } = useDepartmentTree(d.id, sees && (tree || drawer === 'speed'));
  const [treeZoom, setTreeZoom] = useState(1);
  const [treeFit, setTreeFit] = useState(0);
  const [openAgent, setOpenAgent] = useState<{ id: string; key: number; top: number } | null>(null);
  const chrome = useDepartmentSpace(language, panel);
  useEffect(() => {
    if (!drawer) return;
    /* An Escape the task panel over the drawer took closes only that panel. */
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setDrawer(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawer]);

  const s = useMemo(() => schemaLayout(d, reach.length), [d, reach.length]);
  const paths = useMemo(() => stepPaths(s), [s]);
  const box = useRef<HTMLDivElement>(null);
  const { view, setView, zoomAt, handlers, dragged } = usePanZoom(box, `${d.id}:${tree}`, { min: MIN_K, max: MAX_K });
  const covered = panel ? COVER[panel] : 0;

  /* Opens at a readable size from the left when the schema is wider than the screen, as the prototype does; Fit shows all of it. */
  const place = useCallback(
    (whole: boolean) => {
      const el = box.current;
      if (!el || !el.clientWidth) return;
      const width = el.clientWidth - (el.clientWidth > NARROW ? covered : 0);
      const padTop = 76, padBottom = 76, padX = 48;
      const bw = s.right + 80, bh = s.h + 40;
      const fitK = Math.max(MIN_K, Math.min((width - padX * 2) / bw, (el.clientHeight - padTop - padBottom) / bh, 1));
      const k = whole || fitK >= START_K ? fitK : START_K;
      const x = k === fitK ? (width - bw * k) / 2 + 40 * k : padX + 40 * k;
      const y = k === fitK ? padTop + (el.clientHeight - padTop - padBottom - bh * k) / 2 + 20 * k : padTop + 20 * k;
      setView({ k, x, y, smooth: true });
    },
    [s.right, s.h, covered, setView],
  );

  useEffect(() => {
    place(false);
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [place, tree]);

  /* The line from the head to each employee: blue while it works on the head's task, yellow for five minutes after it gave
     a result back, as the server keeps them. */
  const stateOf = useWorkLines(d.workLines, serverNow);
  const rework = useRework(d.reworkAt, serverNow);
  const stageOf = (id: string) => s.frames.find(f => f.members.some(m => m.e.id === id))?.stage ?? -1;
  /* A message runs amber up to the head and back from a gate, cyan down and on. */
  const wayTone = (from: string, to: string) => (to === s.head?.id || stageOf(to) < stageOf(from) ? 'a' : 'c');

  /* Real changes only: an employee's chip flashes, a pulse runs where its work went, and the line below says what happened. */
  const seen = useRef<Seen | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
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
      if (!fired.length || still) return;
      setShots(x => [...x, ...fired]);
      for (const f of fired) later(pulseSeconds(f.pts, PULSE_SPEED) * 1000, () => setShots(x => x.filter(y => y.key !== f.key)));
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
    seen.current = new Map(d.employees.map(e => [e.id, { status: e.status, taskId: e.task?.id ?? null, bounces: e.task?.bounces ?? 0 }]));
    if (!before) return;
    const fired: Shot[] = [];
    const changed: string[] = [];
    let text: string | null = null;
    for (const e of d.employees) {
      const was = before.get(e.id);
      if (!was) continue;
      const taskId = e.task?.id ?? null;
      const cameBack = !!e.task && was.taskId === taskId && e.task.bounces > was.bounces;
      if (!cameBack && was.status === e.status && was.taskId === taskId) continue;
      changed.push(e.id);
      /* A gate sent the work back: said in words, with no amber dot, which the line of work keeps for a result given back. */
      if (cameBack) {
        text = t.dept.cameBack(e.name);
        continue;
      }
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

  function open(agentId: string) {
    if (!dragged()) onOpen(agentId);
  }

  function openDecisions(personId: string) {
    if (!dragged()) onOpenDecisions?.(personId);
  }

  /* A switch shows at once and holds until the company says the same; a refusal puts it back and says why. */
  const [switched, setSwitched] = useState<Record<string, boolean>>({});
  useEffect(() => setSwitched(x => Object.fromEntries(Object.entries(x).filter(([id, on]) => d.employees.find(e => e.id === id)?.on !== on))), [d.employees]);
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
  const stats = t.dept.stats(working, d.employees.length, s.frames.length, s.gates.length);
  const far = view.k < FAR_K;
  const worldStyle = {
    width: s.right,
    height: s.h,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    transition: still || !view.smooth ? 'none' : 'transform .8s cubic-bezier(.3,.7,.2,1)',
    ['--k' as string]: far ? Math.min(2, Math.max(1, 0.72 / view.k)).toFixed(3) : '1',
  } as CSSProperties;
  const drawerTitle = drawer === 'speed' ? t.dept.speed : drawer === 'tasks' ? t.dept.tasksButton : t.dept.about;
  const treeButton = tree ? t.dept.mapButton : t.dept.treeButton;
  const lines = (...cls: Line['cls'][]) => s.lines.filter(l => cls.includes(l.cls)).map((l, i) => <Wire key={`${l.cls}${i}`} l={l} />);

  function openTreeAgent(id: string, top: number) {
    setTree(true);
    setOpenAgent(previous => ({ id, top, key: (previous?.key ?? 0) + 1 }));
  }

  function changeZoom(factor: number) {
    if (tree) setTreeZoom(k => Math.max(.5, Math.min(3, k * factor)));
    else zoomAt(factor);
  }

  function fitCanvas() {
    if (!tree) return place(true);
    setTreeZoom(1);
    setTreeFit(n => n + 1);
  }

  return (
    <div className={`dview${drawer === 'speed' && !panel ? ' spd-open' : ''}`} ref={chrome.root} style={chrome.style}>
      {tree && (workTree ? (
        <TreeView tree={workTree} department={d} zoom={treeZoom} fit={treeFit} openAgent={openAgent} onOpenTask={onOpenTask} />
      ) : <div className="tview"><p className="tv-empty glass">{treeFailure ? errorText(t, treeFailure) : t.common.loading}</p></div>)}
      {!tree && (
      <div className={`dcanvas${far ? ' far' : ''}`} ref={box} role="region" aria-label={t.dept.schema} {...handlers}>
        <div className="world" style={worldStyle}>
          {s.frames.map(f => (
            <div key={f.key || 'others'} className={`frame${f.role?.gate != null ? ' gt' : ''}`} style={{ left: f.x, top: FT, width: FW, height: f.h }}>
              <Edge cut={14} corner>
                <span className={`fh${f.role && canGive ? ' has-sw' : ''}`}>
                  <span className="fn">{f.role ? f.role.title[language] : t.dept.others}</span>
                  {f.role && <span className="fa">{f.role.description[language]}</span>}
                  <span className="fc">{t.dept.agents(f.members.length)}</span>
                </span>
              </Edge>
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
            </div>
          ))}
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
            {rework && lines('rl')}
            {s.report && <Wire l={{ cls: 'pl', pts: s.report.pts, arrow: true }} />}
            <MemberLines s={s} toMember={paths.toMember} stateOf={stateOf} still={still} />
            {shots.map(x => (
              <Pulse key={x.key} pts={x.pts} speed={PULSE_SPEED} once tone={x.tone} />
            ))}
          </svg>
          {s.gates.map(g => (
            <span key={g.x} className="gl" style={{ left: g.x, top: CY + 12 }}>
              {g.last ? t.dept.lastGate : t.dept.gate(g.n)}
            </span>
          ))}
          {rework && s.back && (
            <span className="llab ret" style={{ left: s.back[0], top: s.back[1] }}>
              {t.dept.sentBackLine}
            </span>
          )}
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
              onOpen={open}
              onSwitch={s.head && canGive ? flip(s.head) : undefined}
            />
          </section>
          {reach.map((p, k) => (
            <div key={p.id} className="pchip" style={{ left: s.people[k]![0], top: s.people[k]![1], width: PW, height: PH }}>
              <PersonButton person={p} onOpen={() => openDecisions(p.id)}>
                <Edge cut={8}>
                  <PersonIcon />
                  <span className="pn">
                    <b>{p.name}</b>
                    <span>{p.title || t.dept.leads}</span>
                  </span>
                </Edge>
              </PersonButton>
            </div>
          ))}
          <section aria-labelledby={`${id}-members`} className="slayer">
            <h3 id={`${id}-members`} className="sr">
              {t.dept.members}
            </h3>
            {s.frames.flatMap(f =>
              f.members.map(m => (
                <Chip key={m.e.id} e={shown(m.e)} x={m.x} y={m.y} on={selected === m.e.id} flash={flashing.has(m.e.id)} onOpen={() => open(m.e.id)} onSwitch={canGive ? flip(m.e) : undefined} />
              )),
            )}
          </section>
        </div>
        {!d.employees.some(e => e.kind !== 'head') && <p className="dv-empty glass">{t.dept.noMembers}</p>}
      </div>

      )}

      <nav className="crumbs" aria-label={deptLabel(t, d)}>
        {/* The whole bar goes back, so nobody has to aim at the small arrow. */}
        <button className="crumb glass" type="button" aria-label={t.dept.back} title={t.dept.back} onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          <h2>{deptLabel(t, d)}</h2>
          <span className="role">{d.roleCode}</span>
        </button>
      </nav>

      <div className="dv-acts" ref={chrome.actions} onPointerDown={e => e.stopPropagation()}>
        {sees && <>
          <button className="hbtn glass ib" type="button" aria-label={treeButton} title={treeButton} onClick={() => setTree(!tree)}>{tree ? <MapIcon /> : <TreeIcon />}</button>
          <button className={`hbtn glass ib${drawer === 'speed' ? ' on' : ''}`} type="button" aria-label={t.dept.speed} title={t.dept.speed} aria-expanded={drawer === 'speed'} onClick={() => setDrawer(drawer === 'speed' ? null : 'speed')}><SpeedIcon /></button>
        </>}
        {sees && (
          <button className={`hbtn glass${drawer === 'tasks' ? ' on' : ''}`} type="button" aria-expanded={drawer === 'tasks'} onClick={() => setDrawer(drawer === 'tasks' ? null : 'tasks')}>
            {t.dept.tasksButton}
          </button>
        )}
        <button className={`hbtn glass${drawer === 'about' ? ' on' : ''}`} type="button" aria-expanded={drawer === 'about'} onClick={() => setDrawer(drawer === 'about' ? null : 'about')}>
          {t.dept.about}
        </button>
        {company && (
          <button className="btn" type="button" onClick={onHire}>
            {t.dept.hire}
          </button>
        )}
      </div>

      {drawer && (
        <aside className={`dv-drawer${drawer === 'speed' ? ` spd${panel ? '' : ' right'}` : ''}`} aria-label={drawerTitle}>
          <DrawerHead title={drawerTitle} onClose={() => setDrawer(null)} />
          {drawer === 'speed' ? (workTree ? <SpeedPanel tree={workTree} department={d} onAgent={openTreeAgent} /> : <div className="dv-drawer-b">{treeFailure ? errorText(t, treeFailure) : t.common.loading}</div>) : (
          <div className="dv-drawer-b">
            {drawer === 'tasks' && sees && <DeptTasks department={d} head={head} canGive={canGive} selected={selectedTask} onOpenTask={onOpenTask} />}
            {drawer === 'about' && (
              <>
                {company && (
                  <section aria-labelledby={`${id}-repo`}>
                    <h3 id={`${id}-repo`}>{t.dept.repository}</h3>
                    <RepoSettings placeId={d.id} repository={d.repository} />
                  </section>
                )}
                {d.products.length > 0 && (
                  <section aria-labelledby={`${id}-products`}>
                    <h3 id={`${id}-products`}>{t.dept.products}</h3>
                    <ul className="dv-list">
                      {d.products.map(p => (
                        <li key={p.id}>
                          <b>{p.name}</b>
                          {company && <RepoSettings placeId={p.id} repository={p.repository} compact />}
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

      <ZoomBar k={tree ? treeZoom : view.k} step={tree ? 1.25 : 1.2} onZoom={changeZoom} onFit={fitCanvas} />
      {/* A panel at the right takes the room the line needs. */}
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
