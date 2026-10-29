import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Department, Org, SubView } from '../types';
import { Edge } from '../ui/Edge';
import { AgentIcon, LogoMark, PersonIcon } from '../ui/icons';
import { Pulse, toD, useReducedMotion, type Point } from '../ui/wires';

/* World coordinates, laid out like the approved prototype: people on top, the orchestrator in the middle, departments in two columns. */
const W = 1200, H = 900, CX = W / 2, CY = 420, HUB = 120;
const CHIP_W = 184, CHIP_H = 56, CHIP_GAP = 20;
const CHIPS_TOP = CY - 384, BUS_Y = CY - 314;
const DEPT_W = 240, DEPT_H = 104;
/* Where a department trace turns: 84 out on the diagonal, and the inner side of each column. */
const BEND = 84, INNER = 210;
const GAUGE_SEGMENTS = 24;
const MIN_K = 0.3, MAX_K = 2.5;

type View = { x: number; y: number; k: number };
export type DeptSpot = { x: number; y: number; w: number; h: number; path: Point[] };

export function orchestratorStatus(t: Messages, sub: SubView | null): string {
  if (!sub) return t.map.needsSubscription;
  if (sub.kind === 'api_key') return t.map.runsOnKey(PROVIDER_NAMES[sub.provider], sub.last4 ?? '');
  if (sub.status === 'waiting_machine') return t.map.waitingMachine(sub.owner.name);
  if (sub.status === 'needs_login') return t.map.waitingLogin(PROVIDER_NAMES[sub.provider]);
  if (!sub.online) return t.map.machineOffline(sub.owner.name);
  return t.map.runsOnPersonal(sub.owner.name, PROVIDER_NAMES[sub.provider]);
}

/* Departments fill the left and right columns in turn, top row first, each on a trace that leaves the hub at 45 degrees. */
export function deptLayout(n: number): DeptSpot[] {
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const row = Math.floor(i / 2);
    const up = row === 0 ? -1 : 1;
    const midY = row === 0 ? CY - 220 : CY + 220 + 160 * (row - 1);
    const edgeX = CX + side * INNER;
    return {
      x: side < 0 ? edgeX - DEPT_W : edgeX,
      y: midY - DEPT_H / 2,
      w: DEPT_W,
      h: DEPT_H,
      path: [[CX, CY], [CX + side * BEND, CY + up * BEND], [CX + side * BEND, midY], [edgeX, midY]],
    };
  });
}

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

/* The part of the world that has something on it, so Fit fills the screen with it. */
function contentBounds(org: Org): { x0: number; y0: number; x1: number; y1: number } {
  const half = Math.max(chipsWidth(org.people.length) / 2, 260);
  const b = { x0: CX - half, x1: CX + half, y0: CHIPS_TOP, y1: CY + HUB + (org.departments.length ? 40 : 110) };
  for (const s of deptLayout(org.departments.length)) {
    b.x0 = Math.min(b.x0, s.x);
    b.x1 = Math.max(b.x1, s.x + s.w);
    b.y1 = Math.max(b.y1, s.y + s.h);
  }
  return b;
}

export function MapScreen() {
  const t = useT();
  const still = useReducedMotion();
  const [org, setOrg] = useState<Org | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    api.get<Org>('/api/org').then(
      data => live && setOrg(data),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, []);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !el.clientWidth || !org) return;
    const { x0, y0, x1, y1 } = contentBounds(org);
    /* The header floats over the top of the map and the zoom over the bottom. */
    const padX = 32, padTop = 76, padBottom = 72;
    const room = el.clientHeight - padTop - padBottom;
    const k = Math.max(MIN_K, Math.min((el.clientWidth - padX * 2) / (x1 - x0), room / (y1 - y0), 1.15));
    setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: padTop + (room - (y1 - y0) * k) / 2 - y0 * k });
  }, [org]);

  useEffect(() => {
    fit();
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const el = box.current;
    setView(v => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      const cx = px ?? (el ? el.clientWidth / 2 : 0);
      const cy = py ?? (el ? el.clientHeight / 2 : 0);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, org]);

  function down(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }
  function up() {
    drag.current = null;
  }

  if (failure !== null) return <p className="alert map-failure" role="alert">{errorText(t, failure)}</p>;
  if (!org) return <div className="map" aria-busy="true" />;

  const depts = org.departments;
  const spots = deptLayout(depts.length);
  const chips = chipCenters(org.people.length);
  const chipsW = chipsWidth(org.people.length);
  const gauge = gaugeArc(org.agents.working, org.agents.total);

  return (
    <div className="map" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="world" style={{ width: W, height: H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <div className="halo" style={{ left: CX - 260, top: CY - 260, width: 520, height: 520 }} />
        <svg className="wires" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {chips.length > 0 && (
            <>
              <path className="tr" d={`M ${chips[0]} ${CHIPS_TOP + CHIP_H} V ${BUS_Y} H ${chips[chips.length - 1]} V ${CHIPS_TOP + CHIP_H}`} />
              {chips.slice(1, -1).map(x => (
                <path key={x} className="tr" d={`M ${x} ${CHIPS_TOP + CHIP_H} V ${BUS_Y}`} />
              ))}
              <path className="tr" data-wire="people" d={`M ${CX} ${BUS_Y} V ${CY - HUB}`} />
              <circle className="via" cx={CX} cy={BUS_Y} r="4" />
            </>
          )}
          {spots.map((s, i) => (
            <path key={depts[i]!.id} className="tr" data-wire={depts[i]!.id} d={toD(s.path)} />
          ))}
          {spots.map((s, i) => (
            <circle key={depts[i]!.id} className="via" cx={s.path[2]![0]} cy={s.path[2]![1]} r="4" />
          ))}
        </svg>

        <ul className="chips" style={{ left: CX - chipsW / 2, top: CHIPS_TOP, gap: CHIP_GAP }} aria-label={t.map.leaders}>
          {org.people.map(p => (
            <li key={p.id} style={{ width: CHIP_W, height: CHIP_H }}>
              <Edge cut={8} className="chip">
                <PersonIcon label={t.map.person} />
                <span>
                  <b>{p.name}</b>
                  <small>{p.title || t.map.wholeCompany}</small>
                </span>
              </Edge>
            </li>
          ))}
        </ul>

        <div className="hub" style={{ left: CX - HUB, top: CY - HUB, width: HUB * 2, height: HUB * 2 }}>
          <svg className="hub-art" viewBox="0 0 240 240" aria-hidden="true">
            <circle className="hub-bg" cx="120" cy="120" r="116" />
            <g className="spin">
              <circle className="hub-ring" cx="120" cy="120" r="119" />
            </g>
            <path className="gauge-bg" d="M 17 120 A 103 103 0 0 1 223 120" pathLength={GAUGE_SEGMENTS} />
            <path className="gauge" d={gauge.d} pathLength={gauge.n || 1} />
            <circle className="hub-in" cx="120" cy="120" r="88" />
            <path className="hub-hz" d="M 40 132 L 200 132" />
            {/* Motion means real work: the dot runs only while an agent works. Pulses on the traces wait for real messages (M3). */}
            {!still && org.agents.working > 0 && <Pulse pts={GAUGE_TRACK} speed={55} bounce tone="k" />}
          </svg>
          <LogoMark className="hub-mark" />
          <span className="hub-num">
            <b>{org.agents.working}</b>
            <span>/</span>
            <span>{org.agents.total}</span>
          </span>
          <span className="sr">{t.map.agentsWorking}</span>
        </div>
        <p className="hub-orchestrator" style={{ left: CX - 180, top: CY + HUB + 14 }}>
          <AgentIcon label={t.map.agent} />
          <b>{t.map.orchestrator}</b>
          <span>{orchestratorStatus(t, org.orchestrator?.subscription ?? null)}</span>
        </p>

        {depts.length === 0 && (
          <p className="map-empty" style={{ left: CX - 260, top: CY + HUB + 64 }}>{t.map.empty}</p>
        )}

        {depts.map((d: Department, i) => (
          <div key={d.id} className="dept" style={{ left: spots[i]!.x, top: spots[i]!.y, width: DEPT_W, height: DEPT_H }}>
            <Edge cut={12}>
              <span className="role">{d.roleCode}</span>
              <b className="dname">{d.name}</b>
              <span className="cnt">{t.map.teams(d.teams.length)}</span>
            </Edge>
          </div>
        ))}
      </div>

      <div className="zoom" onPointerDown={e => e.stopPropagation()}>
        <button className="btn small ghost" type="button" aria-label={t.map.zoomOut} onClick={() => zoomAt(1 / 1.2)}>−</button>
        <button className="btn small ghost" type="button" aria-label={t.map.zoomIn} onClick={() => zoomAt(1.2)}>+</button>
        <button className="btn small ghost" type="button" aria-label={t.map.showAll} onClick={fit}>{t.map.fit}</button>
      </div>
    </div>
  );
}
