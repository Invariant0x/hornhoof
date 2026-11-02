import { useCallback, useEffect, useRef, useState } from 'react';
import { deptLabel, errorText, useLanguage, useT, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import { useStream, type LiveMessage } from '../live';
import { mapPeople, useOrg } from '../org';
import type { Department, Employee, EmployeeStatus, Endpoint, Me, Org, SubView } from '../types';
import { accessText } from '../ui/AccessPicker';
import { Bar, percent } from '../ui/Bar';
import { usePanZoom, ZoomBar } from '../ui/canvas';
import { Edge } from '../ui/Edge';
import { LogoMark, PersonIcon } from '../ui/icons';
import { PersonButton } from '../ui/PersonButton';
import { Pulse, pulseSeconds, toD, useReducedMotion, type Point } from '../ui/wires';
import { useWorkLines } from '../ui/work-lines';
import { clock } from './Subscriptions';

/* World coordinates, laid out like the prototype: people on top, the orchestrator in the middle, departments in two columns around him. */
const W = 1200, H = 900, CX = W / 2, CY = 420, HUB = 120;
const CHIP_W = 160, CHIP_H = 56, CHIP_GAP = 20;
const DEPT_W = 280, DEPT_H = 160;
/* Up to two rows sit at the prototype's corners; more rows stack evenly around the hub, this far apart. */
const CORNER = 220, ROW = 220;
/* Room between the people and the top row, and above whatever comes below the hub or the lowest row. */
const GAP = 28;
const BELOW = CY + HUB + GAP;
/* Where a department trace turns: 84 out on the diagonal, and the inner side of each column. */
const BEND = 84, INNER = 210;
const GAUGE_SEGMENTS = 24;
const MIN_K = 0.3, MAX_K = 2.5;
/* The orchestrator's window covers the right of a wide screen; Fit keeps the company clear of it. */
const WINDOW_W = 672, NARROW = 760;
const PULSE_SPEED = 100;
/* How long a pulse waits for its end to appear on the map. */
const HOLD_MS = 5000;
/* Flying into a department takes this long before its view opens. */
const FLY_MS = 600;
/* A square of an employee flashes this long when what it does changes, and a department's frame when work reaches or leaves it. */
const PING_MS = 950;
const FLASH_MS = 1400;

export type DeptSpot = { x: number; y: number; w: number; h: number; path: Point[] };

/* limitAt: the time his plan's limit resets, while it is at it. */
export function orchestratorStatus(t: Messages, sub: SubView | null, limitAt: string | null = null): string {
  if (!sub) return t.map.needsSubscription;
  if (sub.kind !== 'api_key') {
    if (sub.status === 'waiting_machine') return t.map.waitingMachine(sub.owner.name);
    if (sub.status === 'needs_login') return t.map.waitingLogin(PROVIDER_NAMES[sub.provider]);
    if (!sub.online) return t.map.machineOffline(sub.owner.name);
  }
  if (limitAt) return t.map.waitingLimit(limitAt);
  return sub.kind === 'api_key' ? t.map.runsOnKey(PROVIDER_NAMES[sub.provider], sub.last4 ?? '') : t.map.runsOnPersonal(sub.owner.name, PROVIDER_NAMES[sub.provider]);
}

/* How far above or below the hub each row's middle sits. */
function rowOffsets(rows: number): number[] {
  if (rows <= 2) return [-CORNER, CORNER].slice(0, rows);
  return Array.from({ length: rows }, (_, r) => (r - (rows - 1) / 2) * ROW);
}

/* Departments fill the left and right columns in turn, top row first. A row level with the hub runs straight out; the others leave it at 45 degrees. */
export function deptLayout(n: number): DeptSpot[] {
  const offsets = rowOffsets(Math.ceil(n / 2));
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const midY = CY + offsets[Math.floor(i / 2)]!;
    const up = Math.sign(midY - CY);
    const edgeX = CX + side * INNER;
    return {
      x: side < 0 ? edgeX - DEPT_W : edgeX,
      y: midY - DEPT_H / 2,
      w: DEPT_W,
      h: DEPT_H,
      path: up ? [[CX, CY], [CX + side * BEND, CY + up * BEND], [CX + side * BEND, midY], [edgeX, midY]] : [[CX, CY], [edgeX, CY]],
    };
  });
}

/* The people sit just above the top row, and their bus runs 14 below them. */
function chipsTop(n: number): number {
  return CY + Math.min(-CORNER, rowOffsets(Math.ceil(n / 2))[0] ?? -CORNER) - DEPT_H / 2 - GAP - CHIP_H;
}
const busY = (n: number) => chipsTop(n) + CHIP_H + 14;

/* The company's turn sits right under the hub, between the traces that leave it downwards, in two lines at most. */
const TURN_TOP = CY + HUB + 10, TURN_W = 2 * BEND - 16, TURN_H = 56;

const chipsWidth = (n: number) => n * CHIP_W + Math.max(0, n - 1) * CHIP_GAP;

/* The centers of the people chips, left to right. */
function chipCenters(n: number): number[] {
  const left = CX - chipsWidth(n) / 2 + CHIP_W / 2;
  return Array.from({ length: n }, (_, i) => left + i * (CHIP_W + CHIP_GAP));
}

/* One gauge segment lights per 1/24 of the agents at work, and at least one while any agent works. */
function gaugeArc(working: number, total: number): { d: string; n: number } {
  const n = working && total ? Math.max(1, Math.round((GAUGE_SEGMENTS * working) / total)) : 0;
  if (!n) return { d: 'M 17 120 A 103 103 0 0 1 17 120', n };
  const a = Math.PI + (Math.PI * n) / GAUGE_SEGMENTS;
  return { d: `M 17 120 A 103 103 0 0 1 ${(120 + 103 * Math.cos(a)).toFixed(2)} ${(120 + 103 * Math.sin(a)).toFixed(2)}`, n };
}

const GAUGE_TRACK: Point[] = Array.from({ length: 37 }, (_, i) => {
  const a = Math.PI + (Math.PI * i) / 36;
  return [120 + 103 * Math.cos(a), 120 + 103 * Math.sin(a)];
});

/* The way from the hub's edge down to a person's card. */
function toPerson(org: Org, id: string): Point[] | null {
  const people = mapPeople(org);
  const i = people.findIndex(p => p.id === id);
  if (i < 0) return null;
  const x = chipCenters(people.length)[i]!;
  const n = org.departments.length;
  return [[CX, CY - HUB], [CX, busY(n)], [x, busY(n)], [x, chipsTop(n) + CHIP_H]];
}

/* The way from an endpoint to the hub: up from a person's chip, or in from a department along its trace. */
function toHub(e: Endpoint, org: Org): Point[] | null {
  if (e.kind === 'orchestrator') return [];
  /* Agents inside one department run on its card. */
  if (e.kind === 'agent') return null;
  if (e.kind === 'person') return toPerson(org, e.id)?.reverse() ?? null;
  const i = org.departments.findIndex(d => d.id === e.id);
  return i < 0 ? null : [...deptLayout(org.departments.length)[i]!.path].reverse();
}

/* The points a message's pulse runs along, or null when one end is not on the map. */
export function pulsePath(from: Endpoint, to: Endpoint, org: Org): Point[] | null {
  const a = toHub(from, org), b = toHub(to, org);
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

const orchestratorReady = (sub: SubView | null) => !!sub && sub.status === 'ready' && (sub.kind === 'api_key' || sub.online);

/* The part of the world that has something on it, so Fit fills the screen with it. */
function contentBounds(org: Org): { x0: number; y0: number; x1: number; y1: number } {
  const half = Math.max(chipsWidth(mapPeople(org).length) / 2, 260);
  const n = org.departments.length;
  const turn = org.turn ? TURN_H : 0;
  const b = { x0: CX - half, x1: CX + half, y0: chipsTop(n), y1: BELOW + turn + (n ? 0 : 120) };
  for (const s of deptLayout(org.departments.length)) {
    b.x0 = Math.min(b.x0, s.x);
    b.x1 = Math.max(b.x1, s.x + s.w);
    b.y1 = Math.max(b.y1, s.y + s.h);
  }
  return b;
}

type Shot = { key: number; pts: Point[]; tone: 'c' | 'a' };

/* onOpenDecisions: a person's card opens the decisions screen showing theirs. */
type Props = { me: Me; windowOpen: boolean; onOpenOrchestrator(): void; inside?: boolean; onOpenDepartment?(id: string): void; onOpenDecisions?(personId: string): void };

/* inside: a department's view is open over the map, which stays flown into it until the view closes. */
export function MapScreen({ me, windowOpen, onOpenOrchestrator, inside = false, onOpenDepartment, onOpenDecisions }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const still = useReducedMotion();
  const company = me.person.scopeKind === 'company';
  const { org, failure } = useOrg();
  const [shots, setShots] = useState<Shot[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const { view, setView, zoomAt, handlers, dragged } = usePanZoom(box, org, { min: MIN_K, max: MAX_K });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const shotKey = useRef(0);
  const held = useRef<{ m: Extract<LiveMessage, { type: 'pulse' }>; at: number }[]>([]);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
      const key = ++shotKey.current;
      setShots(s => [...s, { key, pts, tone: pulseTone(m.from, m.to) }]);
      if (m.from.kind === 'department') flash(m.from.id);
      const id = setTimeout(() => {
        timers.current.delete(id);
        setShots(s => s.filter(x => x.key !== key));
        if (m.to.kind === 'department') flash(m.to.id);
      }, pulseSeconds(pts, PULSE_SPEED) * 1000);
      timers.current.add(id);
    },
    [flash],
  );

  /* The line to each department: blue while its head works on the orchestrator's task, yellow for five minutes after it
     gave a result back, as the server keeps them. */
  const stateOf = useWorkLines(org?.workLines, org?.serverNow);

  /* Real signals only: a pulse runs once per message or move of a task. useOrg keeps the working count and the org itself fresh. */
  useStream((m: LiveMessage) => {
    if (m.type !== 'pulse' || m.from.kind === 'agent' || m.to.kind === 'agent' || still) return;
    const pts = org && pulsePath(m.from, m.to, org);
    if (pts) fire(pts, m);
    /* A pulse to a department that was just made comes before the map has fetched it, so it waits a little for it. */
    else held.current = [...held.current.filter(h => Date.now() - h.at < HOLD_MS), { m, at: Date.now() }];
  });

  useEffect(() => {
    if (!org || !held.current.length) return;
    const now = Date.now();
    held.current = held.current.filter(h => {
      const pts = pulsePath(h.m.from, h.m.to, org);
      if (pts) fire(pts, h.m);
      return !pts && now - h.at < HOLD_MS;
    });
  }, [org, fire]);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !el.clientWidth || !org || inside) return;
    const { x0, y0, x1, y1 } = contentBounds(org);
    /* The header floats over the top of the map and the zoom over the bottom. */
    const padX = 32, padTop = 76, padBottom = 72;
    const width = el.clientWidth - (windowOpen && el.clientWidth > NARROW ? WINDOW_W : 0);
    const room = el.clientHeight - padTop - padBottom;
    const k = Math.max(MIN_K, Math.min((width - padX * 2) / (x1 - x0), room / (y1 - y0), 1.15));
    setView({ k, x: (width - (x1 - x0) * k) / 2 - x0 * k, y: padTop + (room - (y1 - y0) * k) / 2 - y0 * k, smooth: true });
  }, [org, windowOpen, inside, setView]);

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

  if (failure !== null) return <p className="alert map-failure" role="alert">{errorText(t, failure)}</p>;
  if (!org) return <div className="map" aria-busy="true" />;

  const depts = org.departments;
  const sub = org.orchestrator?.subscription ?? null;
  const limitUntil = org.orchestrator?.limitUntil ?? null;
  const limitAt = limitUntil && Date.parse(limitUntil) > Date.now() ? clock(language, limitUntil) : null;
  const status = orchestratorStatus(t, sub, limitAt);
  const spots = deptLayout(depts.length);
  const top = chipsTop(depts.length), bus = busY(depts.length);
  const people = mapPeople(org);
  const chips = chipCenters(people.length);
  const chipsW = chipsWidth(people.length);
  const lineTo = (d: Department) => {
    const head = d.employees.find(e => e.kind === 'head');
    return head && org.orchestrator ? stateOf(org.orchestrator.id, head.id) : 'quiet';
  };
  /* Each person decisions wait for gets a signal of their own from the hub, and the hub blinks while any of them waits. */
  const asked = people.flatMap(p => {
    const pts = p.pendingDecisions ? toPerson(org, p.id) : null;
    return pts ? [{ id: p.id, pts }] : [];
  });
  const gauge = gaugeArc(org.agents.working, org.agents.total);
  const hubPlace = { left: CX - HUB, top: CY - HUB, width: HUB * 2, height: HUB * 2 };
  const hubArt = (
    <>
      <svg className="hub-art" viewBox="0 0 240 240" aria-hidden="true">
        <circle className="hub-bg" cx="120" cy="120" r="116" />
        <g className="spin">
          <circle className="hub-ring" cx="120" cy="120" r="119" />
        </g>
        <path className="gauge-bg" d="M 17 120 A 103 103 0 0 1 223 120" pathLength={GAUGE_SEGMENTS} />
        <path className="gauge" d={gauge.d} pathLength={gauge.n || 1} />
        <circle className="hub-in" cx="120" cy="120" r="88" />
        <path className="hub-hz" d="M 40 132 L 200 132" />
        {/* Motion means real work: the dot runs only while an agent works. */}
        {!still && org.agents.working > 0 && <Pulse pts={GAUGE_TRACK} speed={55} bounce tone="k" />}
      </svg>
      <LogoMark className="hub-mark" />
      <span className="hub-num">
        <b>{org.agents.working}</b>
        <span>/</span>
        <span>{org.agents.total}</span>
      </span>
      <span className="hub-lbl">{t.map.agentsWorking}</span>
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
        <div className="halo" style={{ left: CX - 260, top: CY - 260, width: 520, height: 520 }} />
        <svg className="wires" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {chips.length > 0 && (
            <>
              <path className="tr" d={`M ${chips[0]} ${top + CHIP_H} V ${bus} H ${chips[chips.length - 1]} V ${top + CHIP_H}`} />
              {chips.slice(1, -1).map(x => (
                <path key={x} className="tr" d={`M ${x} ${top + CHIP_H} V ${bus}`} />
              ))}
              <path className="tr" data-wire="people" d={`M ${CX} ${bus} V ${CY - HUB}`} />
              <circle className="via" cx={CX} cy={bus} r="4" />
            </>
          )}
          {spots.map((s, i) => (
            <path key={depts[i]!.id} className="tr" data-wire={depts[i]!.id} d={toD(s.path)} />
          ))}
          {spots.map((s, i) => s.path.length > 2 && <circle key={depts[i]!.id} className="via" cx={s.path[2]![0]} cy={s.path[2]![1]} r="4" />)}
          {/* One solid path over the whole trace, so the color fills it at any zoom. */}
          {spots.map((s, i) => {
            const state = lineTo(depts[i]!);
            return state !== 'quiet' && <path key={depts[i]!.id} className={`tr work ${state}`} data-work={depts[i]!.id} d={toD(s.path)} />;
          })}
          {asked.map(a => (
            <g key={a.id}>
              <path className="tr ask" data-ask={a.id} d={toD(a.pts)} />
              {!still && <Pulse pts={a.pts} speed={PULSE_SPEED} tone="a" />}
            </g>
          ))}
          {shots.map(s => (
            <Pulse key={s.key} pts={s.pts} speed={PULSE_SPEED} once tone={s.tone} />
          ))}
        </svg>

        <ul className="chips" style={{ left: CX - chipsW / 2, top, gap: CHIP_GAP }} aria-label={t.map.leaders}>
          {people.map(p => (
            <li key={p.id} style={{ width: CHIP_W, height: CHIP_H }}>
              <PersonButton person={p} onOpen={() => openDecisions(p.id)}>
                <Edge cut={8} className="chip">
                  <PersonIcon label={t.map.person} />
                  <span>
                    <b>{p.name}</b>
                    <small>{p.title || (p.home ? deptLabel(t, p.home) : p.deputy ? t.map.deputy(accessText(t, p.access, org)) : t.map.wholeCompany)}</small>
                  </span>
                </Edge>
              </PersonButton>
            </li>
          ))}
        </ul>

        {company ? (
          <button className={`hub${windowOpen ? ' on' : ''}${asked.length ? ' attn' : ''}`} type="button" style={hubPlace} aria-label={t.map.openOrchestrator} onPointerDown={e => e.stopPropagation()} onClick={onOpenOrchestrator}>
            {hubArt}
          </button>
        ) : (
          <div className={`hub${asked.length ? ' attn' : ''}`} style={hubPlace}>
            {hubArt}
          </div>
        )}

        {org.turn && (
          <p className="hub-turn" style={{ left: CX - TURN_W / 2, top: TURN_TOP, width: TURN_W }} title={org.turn.goal}>
            <b>{t.tasks.turn(org.turn.number)}</b>
            <span>{org.turn.goal}</span>
          </p>
        )}

        {depts.length === 0 && (
          <div className="start" style={{ left: CX - 260, top: BELOW + (org.turn ? TURN_H : 0) }}>
            <p>{t.map.emptyHint}</p>
            {company && (
              <button className="btn" type="button" onPointerDown={e => e.stopPropagation()} onClick={onOpenOrchestrator}>
                {t.map.build}
              </button>
            )}
          </div>
        )}

        {depts.map((d: Department, i) => (
          <button key={d.id} type="button" className={deptClass(d, flashing.has(d.id))} style={{ left: spots[i]!.x, top: spots[i]!.y, width: DEPT_W, height: DEPT_H }} onClick={() => enter(spots[i]!, d.id)}>
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
            </Edge>
          </button>
        ))}
      </div>

      <ZoomBar k={view.k} onZoom={f => zoomAt(f)} onFit={fit} />
      {/* The orchestrator is the hub; this line says where he runs, until his window opens and says it there. */}
      {!windowOpen && (
        <div className="ticker glass" aria-live="polite" onPointerDown={e => e.stopPropagation()}>
          <span className={`live${orchestratorReady(sub) && !limitAt ? '' : ' off'}`} />
          <span className="tt">{t.map.orchestrator}</span>
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
