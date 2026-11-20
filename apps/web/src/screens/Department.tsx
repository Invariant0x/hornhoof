import type { LineState } from '@hornhoof/protocol/map';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { useStream } from '../live';
import { useDepartmentTree } from '../tasks';
import type { Department, Employee, EmployeeStatus, Me, PersonView } from '../types';
import { Bar, percent } from '../ui/Bar';
import { Chip, agentWorking, doingLine, Listed, modelParts, Switch, STATUS_CLASS } from '../ui/Chip';
import { CANVAS_NARROW as NARROW, FLOAT_GAP, LEFT_PANEL_COVER, canvasSpace, freeRoom, sameView, usePanZoom, ZoomBar, type Edges } from '../ui/canvas';
import { Edge } from '../ui/Edge';
import { AgentIcon, BackIcon, InfoIcon, ListIcon, MapIcon, PersonIcon, ProviderMark, SpeedIcon, TreeIcon } from '../ui/icons';
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
import { stageName } from '../ui/stage-name';
import { TreeView } from './TreeView';
import { useOpenAgent } from './AgentWindowContext';
import { UNDER_MENU, useShellTop } from '../ui/shellBars';
import { SpeedPanel } from './SpeedPanel';
import { arrowD, CH, FW, HH, HW, PH, PW, leadsStage, schemaLayout, stepPaths, type Frame, type Line, type Schema, type Sizes } from './schema';
import { takeEscape } from '../ui/escape';
import { guardedResizeObserver, useRenderGuard } from '../guard';

export { employeeGroups };

/* A department with no repository hands its work in as documents, so its call frames read the plain stage names its
   tasks do. */
const workOf = (d: Pick<Department, 'keepsRepository'>) => ({ resultKind: d.keepsRepository === false ? 'document' as const : 'code' as const });

const frameTitle = (f: Frame, language: 'en' | 'ru', t: ReturnType<typeof useT>, d: Pick<Department, 'keepsRepository'>) =>
  f.oneShot ? stageName(t, workOf(d), f.oneShot.stage) : f.team ? f.team.name : f.role ? f.role.title[language] : t.dept.others;

function frameDescription(role: NonNullable<Frame['role']>, language: 'en' | 'ru', t: ReturnType<typeof useT>): string {
  if (role.schema === 'final_check') return t.dept.finalTurnCheck;
  if (role.schema === 'observer') return t.dept.turnObserver;
  return role.description[language] ?? '';
}

function FrameHeading({ frame: f, language, canGive, department }: { frame: Frame; language: 'en' | 'ru'; canGive: boolean; department: Pick<Department, 'calls' | 'keepsRepository'> }) {
  const t = useT();
  return (
    <Edge cut={14} corner>
      <span className={`fh${f.role && canGive ? ' has-sw' : ''}`}>
        <span className="fn">{frameTitle(f, language, t, department)}</span>
        {f.role && <span className="fa">{frameDescription(f.role, language, t)}</span>}
        {f.oneShot ? <OneShotMarks stage={f.oneShot} calls={department.calls} /> : <span className="fc">{t.dept.agents(f.members.length)}</span>}
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
  /* How much room the department's name takes at the top, as tall as it wraps and the 8 px under it, for the cards that
     open under it (#1639); null once the department closes. */
  onPlate?(room: number | null): void;
};

/* What the cards drawn from a schema measure: its head, each frame's heading and cards, and the people's chips, in its order.
   Every chip stands as tall as the tallest one, so each is measured as tall as its own words need it, for a moment. */
function measureSchema(world: HTMLElement, s: Schema): Sizes {
  const tall = (el: Element | null | undefined) => (el instanceof HTMLElement ? el.offsetHeight : 0);
  const frames = world.querySelectorAll(':scope > .slayer > .frame');
  const chips = s.frames.map((_, i) => [...(frames[i]?.querySelectorAll<HTMLElement>(':scope > .slayer > .dept-chip') ?? [])]);
  const set = chips.flat().map(chip => [chip, chip.style.minHeight] as const);
  for (const [chip] of set) chip.style.minHeight = `${CH}px`;
  const cards: Record<string, number> = {}, headings: Record<string, number> = {};
  s.frames.forEach((f, i) => {
    headings[f.key] = tall(frames[i]?.querySelector('.fh'));
    f.members.forEach((m, k) => (cards[m.e.id] = tall(chips[i]?.[k])));
  });
  for (const [chip, was] of set) chip.style.minHeight = was;
  const head = world.querySelector(':scope > .slayer > :is(.sslot, .shead)');
  return { head: tall(head), cards, headings, people: [...world.querySelectorAll(':scope > .pchip')].map(tall) };
}

/* The schema as its cards measure on the screen: measured before the first paint and again whenever the company or the words
   change, and when a card or a line of a chip grows or shrinks on its own, as its fonts arrive. Far zoom changes no size. */
function useMeasuredSchema(d: Department, people: number, redraw: string) {
  const [sizes, setSizes] = useState<Sizes>(UNMEASURED);
  const s = useMemo(() => schemaLayout(d, people, sizes), [d, people, sizes]);
  const world = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = world.current;
    if (!el) return;
    const measure = () => {
      const next = measureSchema(el, s);
      setSizes(was => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'department-cards');
    for (const card of el.querySelectorAll(':scope > .slayer > .frame :is(.fh, .dept-chip, .dept-chip .edge-in > *), :scope > .slayer > :is(.sslot, .shead), :scope > .pchip')) observer.observe(card);
    return () => observer.disconnect();
  }, [s, redraw]);
  return { s, world, measured: sizes !== UNMEASURED };
}

const UNMEASURED: Sizes = {};

/* The agent window is on the right, settings and task details on the left. */
const COVER = { window: 688, task: LEFT_PANEL_COVER } as const;
const MIN_K = 0.15, MAX_K = 2;
/* Below this scale the schema shows colors instead of text. */
const FAR_K = 0.55;
/* The Head of Design's word for #1489: a department opens with its chips read at once, their 13.5 px names drawn 11 px tall or
   more, on a phone too; a schema that does not fit so opens at this size from its left edge, and the canvas scrolls it. */
export const READABLE_K = 0.82;
/* The schema opens this far from the top of the screen, and at least this far inside its canvas, which starts under the band
   of the top bar and the department's name (#1556): top is how far down the screen the canvas starts. */
const TOP_ROOM = 76, CANVAS_EDGE = 8;

/* Where the schema stands in the room of its canvas, from the canvas's left, as wide and tall as it is, with what its bottom
   keeps for the zoom, the line of what happened as tall as that may grow and the tools, and what its top keeps for the bars
   over it. Whole, between them, when Show everything asks for it or when it fits so at a readable size; otherwise readable,
   from its top left, or on a phone, onHead, with the head's card in the middle across and its top at the top of the room:
   the Head of Design's word for #1554. top: how far down the screen the canvas starts (#1556). free: on a phone, the top of
   the room the bars leave free as measured in the canvas, and then bottom is what Show everything keeps free at its foot.
   hx: the middle of the head's card in the schema. */
export function schemaView(room: { left: number; width: number; height: number; bottom: number; top?: number; free?: number }, size: { right: number; h: number; hx?: number }, whole: boolean, onHead = false) {
  const padTop = room.free ?? Math.max(CANVAS_EDGE, TOP_ROOM - (room.top ?? 0)), padBottom = room.free === undefined ? Math.max(76, room.bottom) : room.bottom, padX = 48;
  const bw = size.right + 80, bh = size.h + 40;
  const fitK = Math.max(MIN_K, Math.min((room.width - padX * 2) / bw, (room.height - padTop - padBottom) / bh, 1));
  const k = whole || fitK >= READABLE_K ? fitK : READABLE_K;
  if (k !== fitK && onHead && size.hx !== undefined) return { k, x: room.left + room.width / 2 - size.hx * k, y: padTop };
  const x = k === fitK ? (room.width - bw * k) / 2 + 40 * k : padX + 40 * k;
  const y = k === fitK ? padTop + (room.height - padTop - padBottom - bh * k) / 2 + 20 * k : padTop + 20 * k;
  return { k, x: room.left + x, y };
}
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
  const style = { left: 0, top: 0, width: HW, minHeight: HH };
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
          <span className="meta">
            <Listed parts={[...(role && role !== head.name ? [role] : []), ...modelParts(t, head)]} />
          </span>
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

/* The line of what happened, in its own direction: as many lines as its words take, up to three. A longer one folds to three,
   and its own button at the end of the first row unfolds it whole and folds it again. It is measured folded, as it shows. */
function HintLine({ said }: { said: Said }) {
  const t = useT();
  const id = useId();
  const fold = useRef<HTMLSpanElement>(null), words = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const text = said?.text ?? t.dept.hint;
  useLayoutEffect(() => {
    setOpen(false);
    const box = fold.current, line = words.current;
    if (!box || !line) return;
    const measure = () => {
      if (box.classList.contains('folded')) setLong(line.offsetHeight > box.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'department-hint');
    observer.observe(line);
    return () => observer.disconnect();
  }, [said?.key]);
  const toggle = open ? t.dept.hintLess : t.dept.hintMore;
  return (
    <div className="ticker glass" aria-live="polite" onPointerDown={e => e.stopPropagation()}>
      <span className="live" />
      {said && <span className="tt">{said.at}</span>}
      <span ref={fold} id={id} className={`tx-fold${open ? '' : ' folded'}`}>
        <span ref={words} key={said?.key ?? 0} className="tx in" dir="auto" title={text}>
          {text}
        </span>
      </span>
      {long && (
        <button className="zbtn tx-more" type="button" aria-expanded={open} aria-controls={id} aria-label={toggle} title={toggle} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>
        </button>
      )}
    </div>
  );
}

/* The zoom bar and the gap after it, along the bottom of a wide screen, where the ticker starts. */
const ZOOM_ROOM = 212;

/* A tool shown as its icon keeps its name as its label and tooltip. */
const named = (icons: boolean, name: string) => (icons ? { 'aria-label': name, title: name } : {});

/* Wrapped actions and the words of the line of what happened determine the tree's floor and the ticker's remaining room. On a
   phone the tools show as icons, and on a wide screen too when their words do not fit between the zoom and the edge: what the
   words need is measured as they are shown, once for each language and set of tools. The name of the department stands 8 px
   under the menu, or under the last bar of the shell while one stands, on every screen (#1635), and the tree and drawers
   start 8 px under it. It moves there by transform, which offsetTop does not see: where it stands comes from the shell. */
function useDepartmentSpace(language: string, panel: Props['panel'], tools: string, onPlate?: (room: number | null) => void) {
  const root = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null), crumbs = useRef<HTMLElement>(null);
  /* plate: how tall the department's name stands, as it wraps; 0 until it is measured. */
  const [space, setSpace] = useState({ right: 16, bottom: 228, plate: 0, tickerHidden: false });
  /* What Show everything leaves free at the bottom: the dock, with the line of what happened as tall as it shows folded. */
  const fitBottom = useRef(76);
  const tickerHidden = space.tickerHidden;
  const [icons, setIcons] = useState(false);
  const need = useRef<{ words: string; px: number } | null>(null);
  const words = `${language}|${tools}`;
  /* While a bar of the shell stands, the name stands under the bars rather than under the menu. */
  const shellTop = useShellTop();
  useLayoutEffect(() => {
    const el = root.current, acts = actions.current;
    if (!el || !acts) return;
    const measure = () => {
      const phone = window.innerWidth <= NARROW;
      const width = el.clientWidth || window.innerWidth;
      if (!phone && !icons) need.current = { words, px: acts.scrollWidth };
      else if (!phone && need.current?.words !== words) {
        setIcons(false);
        return;
      }
      setIcons(phone || (!!el.clientWidth && need.current!.px > width - ZOOM_ROOM - 16));
      const right = phone ? 16 : acts.offsetWidth + 32;
      /* A wide screen ends the tree and the drawers 16 px above the line of what happened, which grows up with its words. */
      const line = el.querySelector<HTMLElement>(':scope > .dv-dock > .ticker');
      const bottom = phone ? (el.clientHeight ? el.clientHeight - (dock.current ?? acts).offsetTop + 8 : 228)
        : Math.max(76, el.clientHeight && line ? el.clientHeight - line.offsetTop + 16 : 0);
      /* The line of what happened keeps its own room: as much as it shows folded, three lines, whatever it says now. */
      const fold = line?.querySelector<HTMLElement>(':scope > .tx-fold.folded');
      const most = fold ? parseFloat(getComputedStyle(fold).maxHeight) : NaN;
      fitBottom.current = bottom + (fold && most > fold.offsetHeight ? most - fold.offsetHeight : 0);
      const name = crumbs.current;
      setSpace({ right, bottom, plate: name?.offsetHeight ?? 0, tickerHidden: !phone && width - right - ZOOM_ROOM < 220 });
      onPlate?.(name?.offsetHeight ? name.getBoundingClientRect().height + 8 : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = guardedResizeObserver(measure, 'department-actions');
    observer.observe(el);
    observer.observe(acts);
    /* On a phone the dock grows with the words of the line in it; on a wide screen the line and the name grow by themselves. */
    if (dock.current) observer.observe(dock.current);
    const line = el.querySelector(':scope > .dv-dock > .ticker');
    if (line) observer.observe(line);
    if (crumbs.current) observer.observe(crumbs.current);
    return () => observer.disconnect();
  }, [panel, icons, words, onPlate, tickerHidden, shellTop]);
  useEffect(() => () => onPlate?.(null), [onPlate]);
  /* The tree starts 8 px under the name, which stands where the shell says: as a bar comes or goes it moves in the same
     render as the shell's top, so the schema follows the name at once. */
  const treeTop = (shellTop ?? UNDER_MENU) + (space.plate || 44) + FLOAT_GAP;
  const style = { '--ticker-right': `${space.right}px`, '--tree-bottom': `${space.bottom}px`, '--tree-top': `${treeTop}px` } as CSSProperties;
  return { root, dock, actions, crumbs, style, icons, tickerHidden: space.tickerHidden, fitBottom, treeTop, shellTop };
}

/* Inside a department: the head above the current task stages and their owners. Tasks, the repository, products and
   people open in a drawer at the left. */
export function pruneSwitched(switched: Record<string, boolean>, employees: Employee[]): Record<string, boolean> {
  const entries = Object.entries(switched);
  if (!entries.length) return switched;
  const kept = entries.filter(([id, on]) => employees.find(e => e.id === id)?.on !== on);
  return kept.length === entries.length ? switched : Object.fromEntries(kept);
}

export function DepartmentView({ me, department: d, deputies, selected, panel, serverNow, onBack, onHire, onOpen, onOpenTask, onOpenDecisions, onOpenTracker, onPlate }: Props) {
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
  const chrome = useDepartmentSpace(language, panel, runs ? 'hire' : '', onPlate);
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!drawer) return;
    /* An Escape the task panel over the drawer took closes only that panel. */
    const close = (e: KeyboardEvent) => { if (takeEscape(e)) setDrawer(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawer]);

  const box = useRef<HTMLDivElement>(null);
  /* What the hand scrolls: the schema as it stands, between the bars floating over it. */
  const edges = useRef<() => Edges | null>(() => null);
  const { view, setView, zoomAt, handlers, dragged } = usePanZoom(box, `${d.id}:${tree}`, { min: MIN_K, max: MAX_K }, undefined, () => edges.current());
  const viewNow = useRef(view);
  viewNow.current = view;
  const far = view.k < FAR_K;
  const { s, world, measured } = useMeasuredSchema(d, reach.length, `${language}|${tree}`);
  const paths = useMemo(() => stepPaths(s), [s]);
  const covered = panel ? COVER[panel] : 0;
  const size = useRef(s);
  useLayoutEffect(() => {
    size.current = s;
  }, [s]);

  /* The room of the canvas that the department's name, the zoom, the line of what happened and the tools leave free, side px
     in from the sides of what an open panel leaves. The canvas runs from the top of the window to its bottom (#1635). */
  const roomOf = useCallback(
    (side?: number) => {
      const el = box.current, root = chrome.root.current;
      if (!el || !el.clientWidth || !root) return null;
      const space = canvasSpace(el.clientWidth, panel === 'window' ? 0 : covered, panel === 'window' ? covered : 0);
      const bars = root.querySelectorAll(':scope > .crumbs, :scope > .dv-dock :is(.zoom, .ticker, .dv-acts)');
      return { space, room: freeRoom(el, bars, space, { top: TOP_ROOM, side }) };
    },
    [covered, panel, chrome.root],
  );
  edges.current = () => {
    const at = tree ? null : roomOf();
    return at && { content: { x0: 0, y0: 0, x1: size.current.right, y1: size.current.h }, room: at.room };
  };

  /* Opens at a readable size, from the left or on a phone on the head's card, when the schema does not fit so; Fit shows all of
     it. It stands from 8 px under the department's name, where the department says the tree starts, to the dock, and Show
     everything keeps free at the bottom what the line of what happened may still grow by. When a bar of the shell comes or
     goes, the name moves and the schema slides after it in the shell's time (#1635). */
  const { fitBottom, treeTop, shellTop } = chrome;
  const placedUnder = useRef<number | null | undefined>(undefined);
  const place = useCallback(
    (whole: boolean) => {
      const el = box.current, at = roomOf();
      if (!el || !at) return;
      const { left, width } = at.space, phone = el.clientWidth <= NARROW;
      const room = { left, width, height: el.clientHeight, free: treeTop, bottom: fitBottom.current };
      const shift = placedUnder.current !== undefined && placedUnder.current !== shellTop;
      placedUnder.current = shellTop;
      const next = schemaView(room, size.current, whole, phone);
      /* Where it already stands or glides to, it keeps going as it goes: a second look as a resize is watched again must not
         turn the shell's slide into Fit's glide. */
      if (sameView(viewNow.current, next)) return;
      viewNow.current = { ...next, smooth: shift ? 'shift' : true };
      setView(viewNow.current);
    },
    [setView, fitBottom, roomOf, treeTop, shellTop],
  );

  /* The schema is placed again when its frames or their staff change, and once its cards are first measured, not when a card
     grows by a line: the layout of its natural sizes says when. */
  const natural = useMemo(() => schemaLayout(d, reach.length), [d, reach.length]);
  useEffect(() => {
    place(false);
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = guardedResizeObserver(() => place(false), 'department');
    ro.observe(el);
    return () => ro.disconnect();
  }, [place, tree, natural.right, natural.h, measured]);

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
  const worldStyle = {
    width: s.right,
    height: s.h,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    transition: still || !view.smooth ? 'none' : view.smooth === 'shift' ? 'transform var(--shell-shift) ease-out' : 'transform .8s cubic-bezier(.3,.7,.2,1)',
    ['--k' as string]: far ? Math.min(2, Math.max(1, 0.72 / view.k)).toFixed(3) : '1',
  } as CSSProperties;
  const drawerName = drawerTitle(t, drawer);
  const treeButton = tree ? t.dept.mapButton : t.dept.treeButton;
  const lines = (...cls: Line['cls'][]) => s.lines.filter(l => cls.includes(l.cls)).map((l, i) => <Wire key={`${l.cls}${i}`} l={l} />);

  return (
    <div className="dview" ref={chrome.root} style={chrome.style}>
      {tree && (workTree ? (
        <TreeView tree={workTree} department={d} onOpenTask={onOpenTask} zoomSlot={zoomSlot} />
      ) : <div className="tview"><p className="tv-empty glass">{treeFailure ? errorText(t, treeFailure) : t.common.loading}</p></div>)}
      {!tree && (
      <div className={`dcanvas${far ? ' far' : ''}`} ref={box} role="region" aria-label={t.dept.schema} {...handlers}>
        <div className="world" ref={world} style={worldStyle}>
          <section aria-labelledby={`${id}-members`} className="slayer">
          <h3 id={`${id}-members`} className="sr">{t.dept.members}</h3>
          {s.frames.map(f => (
            <div key={f.key || 'others'} className={`frame${f.check ? ' gt' : ''}${f.oneShot ? ' frame-calls' : ''}`} role="group" aria-label={frameTitle(f, language, t, d)} style={{ left: f.x, top: s.ft, width: FW, height: f.h }}>
              <FrameHeading frame={f} language={language} canGive={canGive} department={d} />
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
              <div className="slayer">{f.members.map(m => <Chip key={m.e.id} e={shown(m.e)} x={m.x - f.x} y={m.y - s.ft} h={m.h} on={selected === m.e.id} lead={leadsStage(m.e)} flash={flashing.has(m.e.id)} serverNow={serverNow} onOpen={() => open(m.e.id)} onSwitch={canGive ? flip(m.e) : undefined} />)}</div>
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
              <path key={g.x} className="gd" d={`M ${g.x} ${s.cy - 7} L ${g.x + 7} ${s.cy} L ${g.x} ${s.cy + 7} L ${g.x - 7} ${s.cy} Z`} />
            ))}
            {s.report && <Wire l={{ cls: 'pl', pts: s.report.pts, arrow: true }} />}
            <MemberLines s={s} toMember={paths.toMember} stateOf={stateOf} still={still} />
            {shots.map(x => (
              <Pulse key={x.key} pts={x.pts} speed={x.speed} once tone={x.tone} />
            ))}
          </svg>
          {s.gates.map(g => (
            <span key={g.x} className="gl" style={{ left: g.x, top: s.cy + 12 }}>
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
            <div key={p.id} className="pchip" style={{ left: s.people[k]![0], top: s.people[k]![1], width: PW, minHeight: PH }}>
              <PersonButton person={p} frame={{ w: PW, h: s.peopleH[k]!, cut: 8 }} onOpen={() => openDecisions(p.id)}>
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

      <nav className="crumbs" ref={chrome.crumbs} aria-label={deptLabel(t, d)}>
        <button className="hbtn glass ib" type="button" aria-label={t.dept.back} title={t.dept.back} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="crumb glass">
          <h2>{deptLabel(t, d)}</h2>
          <span className="role">{d.roleCode}</span>
        </div>
      </nav>

      {/* The zoom, the line of what happened and the actions: along the bottom of a wide screen, one over the other on a phone. */}
      <div className="dv-dock" ref={chrome.dock}>
        {/* The schema's zoom, or the tree's, which the tree puts here. */}
        <div className="dv-zoom" ref={setZoomSlot}>{!tree && <ZoomBar k={view.k} onZoom={zoomAt} onFit={() => place(true)} />}</div>
        {/* An open panel takes the room the ticker needs. */}
        {!panel && !chrome.tickerHidden && <HintLine said={said} />}
        <div className="dv-acts" ref={chrome.actions} data-fit={chrome.icons ? 'icons' : undefined} onPointerDown={e => e.stopPropagation()}>
          <div className="dv-tools glass">
            <button className="hbtn glass ib" type="button" aria-label={treeButton} title={treeButton} onClick={() => setTree(!tree)}>{tree ? <MapIcon /> : <TreeIcon />}</button>
            <button className={`hbtn glass ib${drawer === 'speed' ? ' on' : ''}`} type="button" aria-label={t.dept.speed} title={t.dept.speed} aria-expanded={drawer === 'speed'} onClick={() => setDrawer(drawer === 'speed' ? null : 'speed')}><SpeedIcon /></button>
            <button className={`hbtn glass${chrome.icons ? ' ib' : ''}`} type="button" {...named(chrome.icons, t.dept.tasksButton)} onClick={() => onOpenTracker?.(d.id)}>
              {chrome.icons ? <ListIcon /> : t.dept.tasksButton}
            </button>
            <button className={`hbtn glass${chrome.icons ? ' ib' : ''}${drawer === 'about' ? ' on' : ''}`} type="button" {...named(chrome.icons, t.dept.about)} aria-expanded={drawer === 'about'} onClick={() => setDrawer(drawer === 'about' ? null : 'about')}>
              {chrome.icons ? <InfoIcon /> : t.dept.about}
            </button>
          </div>
          {/* The orchestrator's window is the whole company's; the owner hires from the roster here. */}
          {runs && (
            <button className="btn" type="button" onClick={company ? onHire : () => setDrawer('hire')}>
              {t.dept.hire}
            </button>
          )}
        </div>
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

    </div>
  );
}
