import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import type { LineState } from '@hornhoof/protocol/map';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { deptLabel, errorText, useLanguage, useT, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import { useStream, type LiveMessage } from '../live';
import { arcD, dashLength, hubSectors, litSquares, sectorFill, sharePercent, TURN_CELLS, workingTurns, type WorkingTurn } from '../hub-turns';
import { arrangedBounds, arrangeMap, deptKey, GAP, H, HALO, HUB, HUB_KEY, personKey, W, type DeptSpot, type MapArrangement, type TopPerson } from '../map-arrange';
import { useMapLayout } from '../map-layout';
import type { PeopleLayout, PersonChip } from '../map-people';
import { mapPeople, useOrg, wholeCompanyPeople, type MapPerson } from '../org';
import type { Department, Employee, EmployeeStatus, Endpoint, Me, Org, SubView } from '../types';
import { accessText } from '../ui/AccessPicker';
import { Bar, percent } from '../ui/Bar';
import { CANVAS_ZOOM_LIMITS, DRAG_PX, LEFT_PANEL_COVER, canvasSpace, usePanZoom, ZoomBar } from '../ui/canvas';
import { Edge } from '../ui/Edge';
import { LogoMark, PersonIcon } from '../ui/icons';
import { PersonButton } from '../ui/PersonButton';
import { PeopleBridgeMasks, peopleMask, PeopleWires } from '../ui/PeopleWires';
import type { Rect } from '../ui/ortho';
import { LiveWay, Pulse, motionSpeed, pulseSeconds, toD, useReducedMotion, type Point } from '../ui/wires';
import { useWorkLines } from '../ui/work-lines';
import { AgentState } from '../ui/AgentState';
import { clock } from './Subscriptions';

export { deptLayout, type DeptSpot } from '../map-arrange';

/* The gauge of working agents runs over the top of the hub, 6 degrees clear of each end of its middle line. */
const GAUGE_SEGMENTS = 24, GAUGE_FROM = 186, GAUGE_TO = 354;
const { min: MIN_K, max: MAX_K } = CANVAS_ZOOM_LIMITS;
/* The orchestrator's window covers the right of a wide screen; Fit keeps the company clear of it. */
const WINDOW_W = 672;
const PULSE_SPEED = 100;
/* How long a pulse waits for its end to appear on the map. */
const HOLD_MS = 5000;
/* Flying into a department takes this long before its view opens. */
const FLY_MS = 600;
/* A square of an employee flashes this long when what it does changes, and a department's frame when work reaches or leaves it. */
const PING_MS = 950;
const FLASH_MS = 1400;
/* A grip is this big to touch on the screen at any zoom. An arrow key moves its block this far, ten times as far with Shift. */
const GRIP = 44, KEY_STEP = 10;

/* What a plan that is not ready waits for: its owner's machine, the login or the first setup of its program. */
function planWaits(t: Messages, sub: SubView): string {
  if (sub.status === 'waiting_machine') return t.map.waitingMachine(sub.owner.name);
  return sub.status === 'needs_setup' ? t.map.waitingSetup(PROVIDER_NAMES[sub.provider]) : t.map.waitingLogin(PROVIDER_NAMES[sub.provider]);
}

/* limitAt: the time his plan's limit resets, while it is at it. */
export function orchestratorStatus(t: Messages, sub: SubView | null, limitAt: string | null = null): string {
  if (!sub) return t.map.needsSubscription;
  if (sub.kind !== 'api_key') {
    if (sub.status !== 'ready') return planWaits(t, sub);
    if (!sub.online) return t.map.machineOffline(sub.owner.name);
  }
  if (limitAt) return t.map.waitingLimit(limitAt);
  return sub.kind === 'api_key' ? t.map.runsOnKey(PROVIDER_NAMES[sub.provider], sub.last4 ?? '') : t.map.runsOnPersonal(sub.owner.name, PROVIDER_NAMES[sub.provider]);
}

/* One gauge segment lights per 1/24 of the agents at work, and at least one while any agent works. */
function gaugeArc(working: number, total: number): { d: string; length: number } {
  const n = working && total ? Math.max(1, Math.round((GAUGE_SEGMENTS * working) / total)) : 0;
  if (!n) return { d: arcD(GAUGE_FROM, GAUGE_FROM), length: 1 };
  const length = dashLength(n);
  return { d: arcD(GAUGE_FROM, GAUGE_FROM + ((GAUGE_TO - GAUGE_FROM) * length) / dashLength(GAUGE_SEGMENTS)), length };
}

const GAUGE_TRACK: Point[] = Array.from({ length: 37 }, (_, i) => {
  const a = ((GAUGE_FROM + ((GAUGE_TO - GAUGE_FROM) * i) / 36) * Math.PI) / 180;
  return [120 + 103 * Math.cos(a), 120 + 103 * Math.sin(a)];
});

/* The turn inside a department's card: its number, the tasks done out of all, and twenty squares lit from the left. It is part
   of the card's one button, which opens the department. */
function DeptTurn({ turn }: { turn: WorkingTurn }) {
  const t = useT();
  const label = t.tasks.turnProgress(turn.done, turn.total);
  const lit = litSquares(turn.done, turn.total);
  return (
    <span className="dept-turn">
      <span className="dt-head">
        <b className="dt-turn">{t.tasks.turn(turn.turnNumber)}</b>
        <span className="dt-cnt">{label}</span>
      </span>
      <span className="sq-bar dept-sq" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={sharePercent(turn.done, turn.total)}>
        {Array.from({ length: TURN_CELLS }, (_, k) => (
          <i key={k} className={k < lit ? 'on' : undefined} />
        ))}
      </span>
    </span>
  );
}

/* The lower half of the hub, one sector per department working in the turn, in the order of their cards. With several, the one
   whose card is pointed at or focused stands out and the others fade. */
function TurnArcs({ turns, pointed }: { turns: WorkingTurn[]; pointed: string | null }) {
  if (!turns.length) return null;
  const sectors = hubSectors(turns.length);
  const lit = turns.length > 1 && turns.some(w => w.id === pointed);
  return (
    <>
      <path className="hub-eq" d="M 11 120 H 23 M 217 120 H 229" />
      {turns.map((w, i) => {
        const s = sectors[i]!, fill = sectorFill(s, w.done, w.total), sep = s.separator;
        return (
          <g key={w.id} className={`turn-sec${lit ? (w.id === pointed ? ' active' : ' dim') : ''}`} data-dept={w.id}>
            <path className="turn-sec-bg" d={arcD(s.from, s.to)} pathLength={dashLength(s.segments)} />
            {fill && <path className="turn-sec-fill" d={fill.d} pathLength={fill.length} />}
            {sep && <line className="turn-sec-sep" x1={sep[0][0]} y1={sep[0][1]} x2={sep[1][0]} y2={sep[1][1]} />}
          </g>
        );
      })}
    </>
  );
}

/* What the hub names under its count: the turn while one department works in it, and with several, the department whose card
   is pointed at. */
function hubTag(t: Messages, turns: WorkingTurn[], pointed: string | null): string | null {
  if (turns.length === 1) return t.tasks.turn(turns[0]!.turnNumber);
  const w = turns.find(x => x.id === pointed);
  return w ? `${w.roleCode} · ${t.tasks.turn(w.turnNumber)}` : null;
}

function topDeptId(org: Org, deptId: string): string | undefined {
  return org.departments.find(d => d.id === deptId || d.products.some(pr => pr.id === deptId))?.id;
}

/* The way from the hub up to a whole-company person's card. */
const toTopPerson = (arr: MapArrangement, id: string): Point[] | null => arr.top.find(p => p.id === id)?.path ?? null;

function deptDecisionRoutes(org: Org, placed: PeopleLayout, personId: string): Point[][] {
  const routes = placed.routes.filter(r => r.personId === personId);
  if (!routes.length) return [];
  const waitingIds = new Set(org.departments.filter(d => d.employees.some(e => e.status === 'waiting')).map(d => d.id));
  const matched = routes.filter(r => waitingIds.has(r.deptId));
  return (matched.length ? matched : [routes[0]!]).map(r => r.pts);
}

/* The ways to each person decisions wait for: from the hub for whole-company people, from their department otherwise. */
function decisionWays(org: Org, arr: MapArrangement): { key: string; id: string; pts: Point[] }[] {
  return mapPeople(org).flatMap(p => {
    if (!p.pendingDecisions) return [];
    const topPts = toTopPerson(arr, p.id);
    if (topPts) return [{ key: p.id, id: p.id, pts: topPts }];
    return deptDecisionRoutes(org, arr.people, p.id).map((pts, i) => ({ key: `${p.id}:${i}`, id: p.id, pts }));
  });
}

const isDeptPerson = (org: Org, id: string) => !wholeCompanyPeople(org).some(p => p.id === id);

function deptPersonRoute(org: Org, arr: MapArrangement, personId: string, deptEndpointId: string): Point[] | null {
  const deptId = topDeptId(org, deptEndpointId);
  const route = deptId ? arr.people.routes.find(r => r.personId === personId && r.deptId === deptId) : undefined;
  return route?.pts ?? null;
}

function deptPersonPulse(from: Endpoint, to: Endpoint, org: Org, arr: MapArrangement): Point[] | null | undefined {
  if (from.kind === 'person' && isDeptPerson(org, from.id)) {
    const pts = to.kind === 'department' ? deptPersonRoute(org, arr, from.id, to.id) : null;
    return pts ? [...pts].reverse() : null;
  }
  if (to.kind === 'person' && isDeptPerson(org, to.id)) {
    return from.kind === 'department' ? deptPersonRoute(org, arr, to.id, from.id) : null;
  }
  return undefined;
}

/* The way from an endpoint to the hub: down from a whole-company person's card, or in from a department along its trace. */
function toHub(e: Endpoint, org: Org, arr: MapArrangement): Point[] | null {
  if (e.kind === 'orchestrator') return [];
  /* Agents inside one department run on its card. */
  if (e.kind === 'agent') return null;
  if (e.kind === 'person') {
    const pts = toTopPerson(arr, e.id);
    return pts ? [...pts].reverse() : null;
  }
  const topId = topDeptId(org, e.id);
  const dept = topId ? arr.depts.find(d => d.id === topId) : undefined;
  return dept ? [...dept.path].reverse() : null;
}

/* The points a message's pulse runs along, on the map as the person arranged it, or null when one end is not on the map. */
export function pulsePath(from: Endpoint, to: Endpoint, org: Org, arr: MapArrangement = arrangeMap(org)): Point[] | null {
  const direct = deptPersonPulse(from, to, org, arr);
  if (direct !== undefined) return direct;
  const a = toHub(from, org, arr), b = toHub(to, org, arr);
  if (!a || !b) return null;
  const pts = [...a, ...[...b].reverse()];
  return pts.length >= 2 ? pts : null;
}

/* Work going back up, to a person or from a department to the hub, runs amber; work handed down runs cyan. */
export const pulseTone = (from: Endpoint, to: Endpoint): 'c' | 'a' => (to.kind === 'person' || (to.kind === 'orchestrator' && from.kind === 'department') ? 'a' : 'c');

/* The line under a department's name: its products, or its teams. */
function deptDetail(t: Messages, d: Department): string {
  if (d.products.length) return d.products.map(p => p.name).join(', ');
  return d.teams.length ? t.map.teams(d.teams.length) : '';
}

/* One square per employee on a department's card, colored by what it does. */
const CELL: Record<EmployeeStatus, string> = { working: 'w', queued: 'q', handed: 'r', waiting: 'h', idle: '', off: 'o' };

/* onChange: someone's status changed since the last look. */
function Cells({ employees, onChange }: { employees: Employee[]; onChange?(): void }) {
  const t = useT();
  const was = useRef(new Map<string, EmployeeStatus>());
  const changedRef = useRef(onChange);
  changedRef.current = onChange;
  const [pinged, setPinged] = useState<Set<string>>(new Set());
  /* Kept apart from the effect, so a fetch that changes nothing does not cancel the end of a flash. */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const changed = employees.filter(e => was.current.has(e.id) && was.current.get(e.id) !== e.status).map(e => e.id);
    was.current = new Map(employees.map(e => [e.id, e.status]));
    if (!changed.length) return;
    changedRef.current?.();
    setPinged(new Set(changed));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPinged(new Set()), PING_MS);
  }, [employees]);
  if (!employees.length) return null;
  return (
    <span className="cells" role="img" aria-label={t.dept.statusSummary(employees.reduce<Partial<Record<EmployeeStatus, number>>>((n, e) => ({ ...n, [e.status]: (n[e.status] ?? 0) + 1 }), {}))}>
      {employees.map((e, k) => (
        <i key={e.id} className={`cell ${CELL[e.status]}${pinged.has(e.id) ? ' ping' : ''}`.trim()} style={{ animationDelay: `${-((k * 37) % 220) / 100}s` }} />
      ))}
    </span>
  );
}

/* busy: someone works, and the frame breathes cyan; waits: nobody works and someone waits for people, so it breathes amber. */
function deptClass(d: Department, flashing: boolean): string {
  const busy = d.employees.some(e => e.status === 'working');
  const waits = !busy && d.employees.some(e => e.status === 'waiting');
  return `dept${busy ? ' busy' : ''}${waits ? ' waits' : ''}${flashing ? ' flash' : ''}`;
}

/* Every card grows for the turn strip while any department works in the turn, and its lines keep their place under the name;
   with-turn: this department works in it. */
const turnClass = (tall: boolean, works: boolean) => (works ? ' tall with-turn' : tall ? ' tall' : '');

const orchestratorReady = (sub: SubView | null) => !!sub && sub.status === 'ready' && (sub.kind === 'api_key' || sub.online);

type Shot = { key: number; pts: Point[]; tone: 'c' | 'a'; personId?: string; speed: number };

const pulsePersonId = (from: Endpoint, to: Endpoint) => from.kind === 'person' ? from.id : to.kind === 'person' ? to.id : undefined;

/* The way to each department runs while its head works on the orchestrator's task, down the trace to the card, and for
   five minutes after it gave a result back, up the trace to the hub. */
function WorkLines({ org, spots, stateOf, still }: { org: Org; spots: MapArrangement['depts']; stateOf(up: string, down: string): LineState; still: boolean }) {
  const orchestrator = org.orchestrator;
  if (!orchestrator) return null;
  return org.departments.map((d, i) => {
    const head = d.employees.find(e => e.kind === 'head');
    const state = head ? stateOf(orchestrator.id, head.id) : 'quiet';
    if (state === 'quiet') return null;
    const down = spots[i]!.path;
    const back = state === 'yellow';
    return <LiveWay key={d.id} pts={back ? [...down].reverse() : down} speed={PULSE_SPEED} tone={back ? 'a' : 'c'} still={still} data={{ 'data-work': d.id }} />;
  });
}

/* Decisions run amber from the hub or the person's department, with the same bridges as the quiet trace. */
function DecisionSignals({ ways, still, placed, prefix }: { ways: { key: string; id: string; pts: Point[] }[]; still: boolean; placed: PeopleLayout; prefix: string }) {
  return ways.map(w => (
    <g key={w.key} mask={peopleMask(placed, prefix, w.id)}>
      <LiveWay pts={w.pts} speed={PULSE_SPEED} tone="a" still={still} data={{ 'data-ask': w.id }} />
    </g>
  ));
}

/* The line under a person's name: their title, else the department they belong to or what they reach. */
function personDetail(t: Messages, p: MapPerson, org: Org): string {
  if (p.title) return p.title;
  if (p.home) return deptLabel(t, p.home);
  return p.deputy ? t.map.deputy(accessText(t, p.access, org)) : t.map.wholeCompany;
}

function PersonChipCard({ org, person, cut, onOpen }: { org: Org; person: MapPerson; cut: number; onOpen(personId: string): void }) {
  const t = useT();
  return (
    <PersonButton person={person} onOpen={() => onOpen(person.id)}>
      <Edge cut={cut} className="chip">
        <PersonIcon label={t.map.person} />
        <span>
          <b>{person.name}</b>
          <small>{personDetail(t, person, org)}</small>
        </span>
      </Edge>
    </PersonButton>
  );
}

/* Whole-company people, on the top row unless the person moved them, each card opening the decisions waiting for that person. */
function PeopleRow({ org, people, cards, onOpen }: { org: Org; people: MapPerson[]; cards: TopPerson[]; onOpen(personId: string): void }) {
  const t = useT();
  if (!cards.length) return null;
  const byId = new Map(people.map(p => [p.id, p]));
  return (
    <ul className="chips" aria-label={t.map.leaders}>
      {cards.flatMap(c => {
        const p = byId.get(c.id);
        return p ? (
          <li key={c.id} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
            <PersonChipCard org={org} person={p} cut={8} onOpen={onOpen} />
          </li>
        ) : [];
      })}
    </ul>
  );
}

/* Department people docked beside their cards or placed in the strip under the lowest row. */
function DeptPeopleChips({ org, chips, byId, onOpen }: { org: Org; chips: PersonChip[]; byId: Map<string, MapPerson>; onOpen(personId: string): void }) {
  const t = useT();
  if (!chips.length) return null;
  return (
    <ul className="dept-chips" aria-label={t.dept.people}>
      {chips.flatMap(c => {
        const p = byId.get(c.id);
        return p ? (
          <li key={c.id} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
            <PersonChipCard org={org} person={p} cut={8} onOpen={onOpen} />
          </li>
        ) : [];
      })}
    </ul>
  );
}

type At = { x: number; y: number };
const ARROWS: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/* The handle at a block's top left corner: drag it by mouse, touch or pen, or move the block with the arrow keys. It stays the
   same size on the screen at any zoom and stands up and to the left of the corner, outside the block, so a press on the block
   still opens it and a press on the map around still moves the map. While the hand moves, onMove shows the block where it is,
   and null puts it back; onPut keeps the place where the hand let go. */
function Grip({ label, corner, from, k, onMove, onPut }: { label: string; corner: Point; from: At; k: number; onMove(at: At | null): void; onPut(at: At): void }) {
  const press = useRef<{ id: number; x: number; y: number; from: At; at: At | null } | null>(null);
  return (
    <button
      type="button"
      className="grip"
      aria-label={label}
      title={label}
      style={{ left: corner[0] - GRIP, top: corner[1] - GRIP, width: GRIP, height: GRIP, transform: `scale(${1 / k})` }}
      onPointerDown={e => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from, at: null };
      }}
      onPointerMove={e => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        e.stopPropagation();
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (!p.at && Math.abs(dx) + Math.abs(dy) <= DRAG_PX) return;
        p.at = { x: Math.round(p.from.x + dx / k), y: Math.round(p.from.y + dy / k) };
        onMove(p.at);
      }}
      onPointerUp={e => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        e.stopPropagation();
        press.current = null;
        if (p.at) onPut(p.at);
      }}
      onPointerCancel={e => {
        if (press.current?.id !== e.pointerId) return;
        press.current = null;
        onMove(null);
      }}
      onKeyDown={e => {
        const step = ARROWS[e.key];
        if (!step) return;
        e.preventDefault();
        const n = e.shiftKey ? KEY_STEP * 10 : KEY_STEP;
        onPut({ x: from.x + step[0] * n, y: from.y + step[1] * n });
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
      </svg>
    </button>
  );
}

/* Where a block's grip stands: at its top left corner, and for the round hub on its rim, up and to the left. */
const gripCorner = (key: string, r: Rect): Point => (key === HUB_KEY ? [r.x + HUB - Math.round(HUB * Math.SQRT1_2), r.y + HUB - Math.round(HUB * Math.SQRT1_2)] : [r.x, r.y]);

/* onOpenDecisions: a person's card opens the decisions screen showing theirs. */
type Props = { me: Me; windowOpen: boolean; leftPanelOpen?: boolean; onOpenOrchestrator(): void; inside?: boolean; onOpenDepartment?(id: string): void; onOpenDecisions?(personId: string): void; onHome?: () => void };

/* inside: a department's view is open over the map, which stays flown into it until the view closes. */
export function MapScreen({ me, windowOpen, leftPanelOpen = false, onOpenOrchestrator, inside = false, onOpenDepartment, onOpenDecisions, onHome }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const still = useReducedMotion();
  const wirePrefix = useId();
  const company = me.person.scopeKind === 'company';
  const { org, failure } = useOrg();
  const [shots, setShots] = useState<Shot[]>([]);
  const [minZoom, setMinZoom] = useState(MIN_K);
  const box = useRef<HTMLDivElement>(null);
  const { view, setView, zoomAt, handlers, dragged } = usePanZoom(box, org, { min: minZoom, max: MAX_K });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const shotKey = useRef(0);
  const held = useRef<{ m: Extract<LiveMessage, { type: 'pulse' }>; at: number }[]>([]);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /* Where this person put blocks, and the block their hand moves now. */
  const layout = useMapLayout();
  const [moving, setMoving] = useState<{ key: string; at: At } | null>(null);
  /* The department whose card the pointer or the keyboard is on, so the hub shows its turn. */
  const [pointed, setPointed] = useState<string | null>(null);
  const arr = useMemo(() => (org ? arrangeMap(org, moving ? { ...layout.placed, [moving.key]: moving.at } : layout.placed) : null), [org, layout.placed, moving]);
  /* Pulses and Fit read the map as it stands, without waiting for it to settle. */
  const arrRef = useRef(arr);
  arrRef.current = arr;

  useEffect(() => {
    const pending = timers.current;
    const flashes = flashTimers.current;
    return () => {
      for (const id of pending) clearTimeout(id);
      pending.clear();
      for (const id of flashes.values()) clearTimeout(id);
      flashes.clear();
    };
  }, []);

  /* A department's frame flashes once; flashing again while it flashes only makes it last. */
  const flash = useCallback((id: string) => {
    setFlashing(s => (s.has(id) ? s : new Set(s).add(id)));
    clearTimeout(flashTimers.current.get(id));
    flashTimers.current.set(
      id,
      setTimeout(() => {
        flashTimers.current.delete(id);
        setFlashing(s => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }, FLASH_MS),
    );
  }, []);

  const fire = useCallback(
    (pts: Point[], m: Extract<LiveMessage, { type: 'pulse' }>) => {
      const key = ++shotKey.current, speed = motionSpeed(PULSE_SPEED, still);
      setShots(s => [...s, { key, pts, tone: pulseTone(m.from, m.to), personId: pulsePersonId(m.from, m.to), speed }]);
      if (m.from.kind === 'department') flash(m.from.id);
      const id = setTimeout(() => {
        timers.current.delete(id);
        setShots(s => s.filter(x => x.key !== key));
        if (m.to.kind === 'department') flash(m.to.id);
      }, pulseSeconds(pts, speed) * 1000);
      timers.current.add(id);
    },
    [flash, still],
  );

  /* The line to each department: blue while its head works on the orchestrator's task, yellow for five minutes after it
     gave a result back, as the server keeps them. */
  const stateOf = useWorkLines(org?.workLines, org?.serverNow);

  /* Real signals only: a pulse runs once per message or move of a task. useOrg keeps the working count and the org itself fresh. */
  useStream((m: LiveMessage) => {
    if (m.type !== 'pulse' || m.from.kind === 'agent' || m.to.kind === 'agent') return;
    const pts = org && pulsePath(m.from, m.to, org, arrRef.current ?? undefined);
    if (pts) fire(pts, m);
    /* A pulse to a department that was just made comes before the map has fetched it, so it waits a little for it. */
    else held.current = [...held.current.filter(h => Date.now() - h.at < HOLD_MS), { m, at: Date.now() }];
  });

  useEffect(() => {
    if (!org || !arr || !held.current.length) return;
    const now = Date.now();
    held.current = held.current.filter(h => {
      const pts = pulsePath(h.m.from, h.m.to, org, arr);
      if (pts) fire(pts, h.m);
      return !pts && now - h.at < HOLD_MS;
    });
  }, [org, arr, fire]);

  /* Moving a block leaves the view where it is; the arrangement coming from the server or put back shows all of it again. */
  const fit = useCallback(() => {
    const el = box.current;
    const shown = arrRef.current;
    if (!el || !el.clientWidth || !org || !shown || inside) return;
    const { x0, y0, x1, y1 } = arrangedBounds(shown, org);
    /* The header floats over the top of the map and the zoom over the bottom. */
    const padX = 32, padTop = 76, padBottom = 72;
    const { left, width } = canvasSpace(el.clientWidth, leftPanelOpen ? LEFT_PANEL_COVER : 0, windowOpen ? WINDOW_W : 0);
    const room = el.clientHeight - padTop - padBottom;
    const k = Math.min((width - padX * 2) / (x1 - x0), room / (y1 - y0), 1.15);
    setMinZoom(Math.min(MIN_K, k));
    setView({ k, x: left + (width - (x1 - x0) * k) / 2 - x0 * k, y: padTop + (room - (y1 - y0) * k) / 2 - y0 * k, smooth: true });
  }, [org, windowOpen, leftPanelOpen, inside, setView, layout.version]);

  useEffect(() => {
    fit();
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /* The map flies into the department's card until it fills the screen, then the department opens. */
  function openDecisions(personId: string) {
    if (!dragged()) onOpenDecisions?.(personId);
  }

  function enter(spot: DeptSpot, id: string) {
    if (dragged() || !onOpenDepartment) return;
    const el = box.current;
    if (!el || !el.clientWidth || still) return onOpenDepartment(id);
    const k = Math.min(el.clientWidth / spot.w, el.clientHeight / spot.h);
    setView({ k, x: el.clientWidth / 2 - (spot.x + spot.w / 2) * k, y: el.clientHeight / 2 - (spot.y + spot.h / 2) * k, smooth: 'fly' });
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      onOpenDepartment(id);
    }, FLY_MS);
    timers.current.add(timer);
  }

  if (unavailableFailure(failure)) return <RouteUnavailable onHome={onHome} />;
  if (failure !== null) return <p className="alert map-failure" role="alert">{errorText(t, failure)}</p>;
  if (!org || !arr) return <div className="map" aria-busy="true" />;

  const depts = org.departments;
  const sub = org.orchestrator?.subscription ?? null;
  const limitUntil = org.orchestrator?.limitUntil ?? null;
  const limitAt = limitUntil && Date.parse(limitUntil) > Date.now() ? clock(language, limitUntil) : null;
  const status = orchestratorStatus(t, sub, limitAt);
  const spots = arr.depts, placed = arr.people, { hub } = arr;
  const mx = hub.x + HUB, my = hub.y + HUB;
  const allPeople = mapPeople(org);
  const peopleById = new Map(allPeople.map(p => [p.id, p]));
  const topPeople = wholeCompanyPeople(org);
  /* The hub blinks while decisions wait for whole-company people wired to it. */
  const asked = decisionWays(org, arr);
  const hubAsked = topPeople.some(p => (p.pendingDecisions ?? 0) > 0);
  const gauge = gaugeArc(org.agents.working, org.agents.total);
  const turns = workingTurns(depts);
  const turnOf = new Map(turns.map(w => [w.id, w]));
  const tag = hubTag(t, turns, pointed);
  const hubClass = `hub${hubAsked ? ' attn' : ''}${tag ? ' has-tag' : ''}`;
  const hubPlace = { left: hub.x, top: hub.y, width: hub.w, height: hub.h };
  /* What each grip names: the orchestrator, a department or a person. */
  const blockName = (key: string): string => {
    if (key === HUB_KEY) return t.map.orchestrator;
    const dept = depts.find(d => deptKey(d.id) === key);
    return dept ? deptLabel(t, dept) : (allPeople.find(p => personKey(p.id) === key)?.name ?? '');
  };
  const arranged = Object.keys(layout.placed).length > 0;
  const hubArt = (
    <>
      <svg className="hub-art" viewBox="0 0 240 240" aria-hidden="true">
        <circle className="hub-bg" cx="120" cy="120" r="116" />
        <g className="spin">
          <circle className="hub-ring" cx="120" cy="120" r="119" />
        </g>
        <path className="gauge-bg" d={arcD(GAUGE_FROM, GAUGE_TO)} pathLength={dashLength(GAUGE_SEGMENTS)} />
        <path className="gauge" d={gauge.d} pathLength={gauge.length} />
        <TurnArcs turns={turns} pointed={pointed} />
        <circle className="hub-in" cx="120" cy="120" r="88" />
        <path className="hub-hz" d="M 64 120 L 176 120" />
        {/* Motion means real work: the dot runs only while an agent works. */}
        {org.agents.working > 0 && <Pulse pts={GAUGE_TRACK} speed={motionSpeed(55, still)} bounce tone="k" />}
      </svg>
      <LogoMark className="hub-mark" />
      <span className="hub-num" title={t.map.agentsWorking}>
        <b>{org.agents.working}</b>
        <span>/</span>
        <span>{org.agents.total}</span>
      </span>
      {tag && (
        <span className="hub-focus-tag" aria-hidden="true">
          {tag}
        </span>
      )}
    </>
  );

  return (
    <div className="map" ref={box} inert={inside} {...handlers}>
      <div
        className="world"
        style={{
          width: W,
          height: H,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transition: still || !view.smooth ? 'none' : view.smooth === 'fly' ? `transform ${FLY_MS / 1000}s cubic-bezier(.55,0,.25,1)` : 'transform .8s cubic-bezier(.3,.7,.2,1)',
        }}
      >
        <div className="halo" style={{ left: mx - HALO, top: my - HALO, width: 2 * HALO, height: 2 * HALO }} />
        <svg className="wires" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <PeopleBridgeMasks placed={placed} prefix={wirePrefix} />
          {arr.bus && (
            <>
              {arr.bus.lines.map(pts => (
                <path key={toD(pts)} className="tr" d={toD(pts)} />
              ))}
              <path className="tr" data-wire="people" d={toD(arr.bus.drop)} />
              <circle className="via" cx={arr.bus.via[0]} cy={arr.bus.via[1]} r="4" />
            </>
          )}
          {arr.top.map(p => p.apart && <path key={p.id} className="tr" data-wire={p.id} d={toD(p.path)} />)}
          {spots.map(s => (
            <path key={s.id} className="tr" data-wire={s.id} d={toD(s.path)} />
          ))}
          {spots.map(s => s.via && <circle key={s.id} className="via" cx={s.via[0]} cy={s.via[1]} r="4" />)}
          <PeopleWires placed={placed} />
          <WorkLines org={org} spots={spots} stateOf={stateOf} still={still} />

          <DecisionSignals ways={asked} still={still} placed={placed} prefix={wirePrefix} />
          {shots.map(s => (
            <g key={s.key} mask={peopleMask(placed, wirePrefix, s.personId)}>
              <Pulse pts={s.pts} speed={s.speed} once tone={s.tone} />
            </g>
          ))}
        </svg>

        <PeopleRow org={org} people={topPeople} cards={arr.top} onOpen={openDecisions} />
        <DeptPeopleChips org={org} chips={placed.chips} byId={peopleById} onOpen={openDecisions} />

        {company ? (
          <button className={`${hubClass}${windowOpen ? ' on' : ''}`} type="button" style={hubPlace} aria-label={t.map.openOrchestrator} onPointerDown={e => e.stopPropagation()} onClick={onOpenOrchestrator}>
            {hubArt}
          </button>
        ) : (
          <div className={hubClass} style={hubPlace}>
            {hubArt}
          </div>
        )}

        {depts.length === 0 && (
          <div className="start" style={{ left: mx - 260, top: hub.y + hub.h + GAP }}>
            <p>{t.map.emptyHint}</p>
            {company && (
              <button className="btn" type="button" onPointerDown={e => e.stopPropagation()} onClick={onOpenOrchestrator}>
                {t.map.build}
              </button>
            )}
          </div>
        )}

        {depts.map((d: Department, i) => (
          <button
            key={d.id}
            type="button"
            className={`${deptClass(d, flashing.has(d.id))}${turnClass(turns.length > 0, turnOf.has(d.id))}`}
            style={{ left: spots[i]!.x, top: spots[i]!.y, width: spots[i]!.w, height: spots[i]!.h }}
            onClick={() => enter(spots[i]!, d.id)}
            onMouseEnter={() => setPointed(d.id)}
            onMouseLeave={() => setPointed(p => (p === d.id ? null : p))}
            onFocus={() => setPointed(d.id)}
            onBlur={() => setPointed(p => (p === d.id ? null : p))}
          >
            <Edge cut={12} corner>
              <span className="row1">
                <b className="dname">{deptLabel(t, d)}</b>
                <span className="cnt" title={t.map.deptAgents}>
                  <b>{d.agents.working}</b>/{d.agents.total}
                </span>
              </span>
              <span className="row2">
                <span className="role">{d.roleCode}</span>
                {deptDetail(t, d) && <span className="detail">{deptDetail(t, d)}</span>}
              </span>
              <Cells employees={d.employees} onChange={() => flash(d.id)} />
              {d.current ? (
                <span className="now task">
                  <i />
                  <span>
                    #{d.current.number} {d.current.title}
                  </span>
                </span>
              ) : (
                d.agents.total === 0 && (
                  <span className="now">
                    <i />
                    <span>{t.map.noAgents}</span>
                  </span>
                )
              )}
              {turnOf.has(d.id) && <DeptTurn turn={turnOf.get(d.id)!} />}
            </Edge>
          </button>
        ))}

        {arr.blocks.map(b => (
          <Grip
            key={b.key}
            label={t.map.moveBlock(blockName(b.key))}
            corner={gripCorner(b.key, b.rect)}
            from={b.rect}
            k={view.k}
            onMove={at => setMoving(at && { key: b.key, at })}
            onPut={at => {
              setMoving(null);
              layout.place(b.key, at);
            }}
          />
        ))}
      </div>

      <ZoomBar k={view.k} onZoom={f => zoomAt(f)} onFit={fit} />
      {(arranged || layout.failed) && (
        <div className="map-arrange" onPointerDown={e => e.stopPropagation()}>
          {layout.failed && <p className="alert" role="alert">{t.map.layoutNotSaved}</p>}
          {arranged && (
            <button className="btn ghost" type="button" onClick={layout.reset}>
              {t.map.putBack}
            </button>
          )}
        </div>
      )}
      {/* The orchestrator is the hub; this line says where he runs, until his window opens and says it there. */}
      {!windowOpen && (
        <div className="ticker glass" aria-live="polite" onPointerDown={e => e.stopPropagation()}>
          <span className={`live${orchestratorReady(sub) && !limitAt ? '' : ' off'}`} />
          <span className="tt">{t.map.orchestrator}</span>
          <AgentState agent={org.orchestrator} serverNow={org.serverNow} />
          <span className="tx" title={status}>{status}</span>
          {org.orchestrator?.effort && <span className="te">{t.agent.effortLine(t.agent.efforts[org.orchestrator.effort] ?? org.orchestrator.effort)}</span>}
          {org.orchestrator?.context != null && (
            <span className="tc" title={t.dept.contextUsed(percent(org.orchestrator.context))}>
              {t.dept.context}
              <Bar used={org.orchestrator.context} />
              {percent(org.orchestrator.context)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
