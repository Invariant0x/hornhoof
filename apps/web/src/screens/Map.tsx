import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Department, Org, SubView } from '../types';
import { Edge } from '../ui/Edge';
import { AgentIcon, LogoMark, PersonIcon } from '../ui/icons';

/* World coordinates. The chief sits in the middle, people above it, departments on an arc around it. */
const W = 1200, H = 860, CX = W / 2, CY = H / 2 + 20, HUB = 120;
const CHIP_W = 184, CHIP_H = 56, DEPT_W = 220, DEPT_H = 96;
const MIN_K = 0.3, MAX_K = 2.5;

type View = { x: number; y: number; k: number };


export function chiefStatus(t: Messages, sub: SubView | null): string {
  if (!sub) return t.map.needsSubscription;
  if (sub.kind === 'api_key') return t.map.runsOnKey(PROVIDER_NAMES[sub.provider], sub.last4 ?? '');
  if (sub.status === 'waiting_machine') return t.map.waitingMachine(PROVIDER_NAMES[sub.provider]);
  return t.map.runsOnPersonal(sub.owner.name, PROVIDER_NAMES[sub.provider]);
}

function deptPositions(n: number): { x: number; y: number }[] {
  /* Spread over the right, bottom and left, leaving the top for people. */
  return Array.from({ length: n }, (_, i) => {
    const a = ((-20 + (220 * (i + 0.5)) / n) * Math.PI) / 180;
    return { x: CX + Math.cos(a) * 410, y: CY + Math.sin(a) * 280 };
  });
}

const chipsWidth = (n: number) => n * CHIP_W + Math.max(0, n - 1) * 12;

/* The part of the world that has something on it, so Fit fills the screen with it. */
function contentBounds(org: Org): { x0: number; y0: number; x1: number; y1: number } {
  const half = Math.max(chipsWidth(org.people.length) / 2, 220);
  const b = { x0: CX - half, x1: CX + half, y0: CY - HUB - CHIP_H - 34, y1: CY + HUB + (org.departments.length ? 40 : 110) };
  for (const p of deptPositions(org.departments.length)) {
    b.x0 = Math.min(b.x0, p.x - DEPT_W / 2);
    b.x1 = Math.max(b.x1, p.x + DEPT_W / 2);
    b.y0 = Math.min(b.y0, p.y - DEPT_H / 2);
    b.y1 = Math.max(b.y1, p.y + DEPT_H / 2);
  }
  return b;
}

export function MapScreen() {
  const t = useT();
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
    const pad = 32;
    const k = Math.max(MIN_K, Math.min((el.clientWidth - pad * 2) / (x1 - x0), (el.clientHeight - pad * 2) / (y1 - y0), 1.15));
    setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: (el.clientHeight - (y1 - y0) * k) / 2 - y0 * k });
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
  const spots = deptPositions(depts.length);
  const chipsW = chipsWidth(org.people.length);

  return (
    <div className="map" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="world" style={{ width: W, height: H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="wires" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          {spots.map((p, i) => (
            <line key={depts[i]!.id} x1={CX} y1={CY} x2={p.x} y2={p.y} />
          ))}
        </svg>

        <ul className="chips" style={{ left: CX - chipsW / 2, top: CY - HUB - CHIP_H - 34 }} aria-label={t.map.leaders}>
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
            <circle className="hub-ring" cx="120" cy="120" r="116" />
            <circle className="hub-gauge" cx="120" cy="120" r="104" pathLength="100" strokeDasharray={`${org.agents.total ? (org.agents.working / org.agents.total) * 100 : 0} 100`} />
          </svg>
          <LogoMark className="hub-mark" />
          <span className="hub-name">{org.company.name}</span>
          <span className="hub-num">{`${org.agents.working}/${org.agents.total}`}</span>
          <span className="hub-label">{t.map.agentsWorking}</span>
        </div>
        <p className="hub-chief" style={{ left: CX - 180, top: CY + HUB + 14 }}>
          <AgentIcon label={t.map.agent} />
          <b>{org.chief?.name ?? t.map.chief}</b>
          <span>{chiefStatus(t, org.chief?.subscription ?? null)}</span>
        </p>

        {depts.length === 0 && (
          <p className="map-empty" style={{ left: CX - 220, top: CY + HUB + 64 }}>{t.map.empty}</p>
        )}

        {depts.map((d: Department, i) => (
          <div key={d.id} className="dept" style={{ left: spots[i]!.x - DEPT_W / 2, top: spots[i]!.y - DEPT_H / 2, width: DEPT_W, height: DEPT_H }}>
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
