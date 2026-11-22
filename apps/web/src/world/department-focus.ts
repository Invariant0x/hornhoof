/* Pack-agnostic Department Mode focus builder and overlay renderer for Stage 8.
   Highlights all buildings and residents belonging to the selected department in its banner color,
   dims the rest of the city with separate ground-vs-actor weighting, and overlays work-path lines
   showing stone handoffs, checkers, head guidance, and one-shot helpers directly on the city map.
   Contains zero theme-specific words. */

import type { Graphics } from 'pixi.js';
import type { CityBuilding, CityState } from './city-layout';
import { tileCenterToWorld, tileTopVertexToWorld, type TileCoord } from './coords';
import type { ResidentEntity } from './residents';

export type DepartmentWorkLinkKind = 'handoff' | 'checker' | 'head_guide' | 'one_shot';

export type DepartmentWorkLink = Readonly<{
  id: string;
  kind: DepartmentWorkLinkKind;
  from: TileCoord;
  to: TileCoord;
  fromLabel: string;
  toLabel: string;
  active: boolean;
}>;

export type DepartmentFocusSpec = Readonly<{
  departmentId: string;
  bannerColor: string;
  highlightedBuildingIds: ReadonlySet<string>;
  highlightedResidentIds: ReadonlySet<string>;
  links: readonly DepartmentWorkLink[];
}>;

export const DEPARTMENT_BANNER_PALETTE = [
  '#2E7BB5',
  '#B85A34',
  '#2F8B69',
  '#8C53B5',
  '#C48A2B',
  '#B54978',
  '#3A8E9E',
  '#6E8A38',
] as const;

function hashText(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function departmentBannerColor(departmentId: string, departmentIndex?: number): string {
  const idx =
    typeof departmentIndex === 'number' && Number.isFinite(departmentIndex) && departmentIndex >= 0
      ? departmentIndex % DEPARTMENT_BANNER_PALETTE.length
      : hashText(departmentId) % DEPARTMENT_BANNER_PALETTE.length;
  return DEPARTMENT_BANNER_PALETTE[idx]!;
}

function parseHex(color: string, fallback: number): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1]!, 16) : fallback;
}

function buildingCenterTile(b: CityBuilding): TileCoord {
  return {
    col: b.col + (b.spanCol - 1) * 0.5,
    row: b.row + (b.spanRow - 1) * 0.5,
  };
}

export function buildDepartmentFocus(
  city: CityState,
  residents: readonly ResidentEntity[],
  departmentId: string,
  options: Readonly<{ departmentIndex?: number; bannerColor?: string }> = {},
): DepartmentFocusSpec {
  const bannerColor = options.bannerColor ?? departmentBannerColor(departmentId, options.departmentIndex);
  const highlightedBuildingIds = new Set<string>();
  const highlightedResidentIds = new Set<string>();

  let deptBuilding: CityBuilding | null = null;
  let flophouseBuilding: CityBuilding | null = null;
  let monumentBuilding: CityBuilding | null = null;
  const houseByAgentId = new Map<string, CityBuilding>();

  for (const b of city.buildings) {
    if (b.kind === 'flophouse') flophouseBuilding = b;
    if (b.kind === 'monument' && (!monumentBuilding || b.departmentId === departmentId)) {
      monumentBuilding = b;
    }
    if (b.departmentId === departmentId) {
      if (b.kind === 'department') deptBuilding = b;
      if (b.kind === 'department' || b.kind === 'house' || b.kind === 'statue') {
        highlightedBuildingIds.add(b.id);
      }
    }
    if (b.kind === 'house') {
      for (const rid of b.residentIds) {
        houseByAgentId.set(rid, b);
      }
      if (b.entityId) houseByAgentId.set(b.entityId, b);
    }
  }

  const deptResidents: ResidentEntity[] = [];
  for (const r of residents) {
    if (r.departmentId === departmentId) {
      highlightedResidentIds.add(r.id);
      deptResidents.push(r);
      const house = houseByAgentId.get(r.agentId) ?? (r.homeBuildingId ? city.buildings.find(b => b.id === r.homeBuildingId) : undefined);
      if (house) highlightedBuildingIds.add(house.id);
    }
  }

  const anchorTile = deptBuilding ? buildingCenterTile(deptBuilding) : city.center;
  const anchorLabel = deptBuilding?.label ?? departmentId;
  const links: DepartmentWorkLink[] = [];

  const heads = deptResidents.filter(r => r.roleClass === 'head');
  const executors = deptResidents.filter(r => r.roleClass === 'executor' || r.roleClass === 'turnkey');
  const checkers = deptResidents.filter(r => r.roleClass === 'checker');
  const dayLaborers = deptResidents.filter(r => r.roleClass === 'day_laborer');

  const tileForResident = (r: ResidentEntity): TileCoord => {
    const house = houseByAgentId.get(r.agentId);
    if (house) return buildingCenterTile(house);
    return { col: r.col, row: r.row };
  };

  /* 1. Department head -> executors / department hub (guidance). */
  for (const head of heads) {
    const from = tileForResident(head);
    const targets = executors.slice(0, 6);
    if (targets.length === 0) {
      links.push({
        id: `head-${head.id}-hub`,
        kind: 'head_guide',
        from,
        to: anchorTile,
        fromLabel: head.name,
        toLabel: anchorLabel,
        active: head.liveState === 'working',
      });
    } else {
      for (const exec of targets) {
        links.push({
          id: `head-${head.id}-${exec.id}`,
          kind: 'head_guide',
          from,
          to: tileForResident(exec),
          fromLabel: head.name,
          toLabel: exec.name,
          active: head.liveState === 'working' || exec.liveState === 'working',
        });
      }
    }
  }

  /* 2. Executors -> department hub & primary goal monument (stone handoff flow). */
  for (const exec of executors.slice(0, 12)) {
    const from = tileForResident(exec);
    links.push({
      id: `handoff-${exec.id}-dept`,
      kind: 'handoff',
      from,
      to: anchorTile,
      fromLabel: exec.name,
      toLabel: anchorLabel,
      active: exec.liveState === 'working',
    });
  }
  if (monumentBuilding) {
    links.push({
      id: `handoff-dept-monument-${monumentBuilding.id}`,
      kind: 'handoff',
      from: anchorTile,
      to: buildingCenterTile(monumentBuilding),
      fromLabel: anchorLabel,
      toLabel: monumentBuilding.label,
      active: executors.some(e => e.liveState === 'working'),
    });
  }

  /* 3. Department hub / executors -> checkers (inspection & rework return loop). */
  for (const chk of checkers.slice(0, 8)) {
    const to = tileForResident(chk);
    links.push({
      id: `checker-dept-${chk.id}`,
      kind: 'checker',
      from: anchorTile,
      to,
      fromLabel: anchorLabel,
      toLabel: chk.name,
      active: chk.liveState === 'working' || chk.hasRecentRework,
    });
  }

  /* 4. One-shot helpers (flophouse or active day-laborers) -> department hub. */
  if (flophouseBuilding) {
    highlightedBuildingIds.add(flophouseBuilding.id);
    links.push({
      id: `oneshot-lodge-${flophouseBuilding.id}`,
      kind: 'one_shot',
      from: buildingCenterTile(flophouseBuilding),
      to: anchorTile,
      fromLabel: flophouseBuilding.label,
      toLabel: anchorLabel,
      active: dayLaborers.length > 0,
    });
  } else if (dayLaborers.length > 0) {
    for (const helper of dayLaborers.slice(0, 4)) {
      links.push({
        id: `oneshot-res-${helper.id}`,
        kind: 'one_shot',
        from: { col: helper.col, row: helper.row },
        to: anchorTile,
        fromLabel: helper.name,
        toLabel: anchorLabel,
        active: true,
      });
    }
  }

  return {
    departmentId,
    bannerColor,
    highlightedBuildingIds,
    highlightedResidentIds,
    links,
  };
}

function linkColor(kind: DepartmentWorkLinkKind, bannerHex: number): number {
  if (kind === 'checker') return 0x4cc9f0;
  if (kind === 'one_shot') return 0xffb703;
  if (kind === 'head_guide') return 0xf8e18c;
  return bannerHex;
}

function linkCss(kind: DepartmentWorkLinkKind, bannerColor: string): string {
  if (kind === 'checker') return '#4CC9F0';
  if (kind === 'one_shot') return '#FFB703';
  if (kind === 'head_guide') return '#F8E18C';
  return bannerColor;
}

function drawDashedArcPixi(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lift: number,
  color: number,
  width: number,
  dashed: boolean,
  timeSec: number,
  active: boolean,
): void {
  const mx = (x1 + x2) * 0.5;
  const my = (y1 + y2) * 0.5 - lift;
  const steps = 16;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    pts.push({
      x: inv * inv * x1 + 2 * inv * t * mx + t * t * x2,
      y: inv * inv * y1 + 2 * inv * t * my + t * t * y2,
    });
  }

  if (dashed) {
    for (let i = 0; i < steps; i += 2) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color, alpha: active ? 0.96 : 0.72, width });
    }
  } else {
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i <= steps; i++) {
      g.lineTo(pts[i]!.x, pts[i]!.y);
    }
    g.stroke({ color, alpha: active ? 0.96 : 0.74, width });
  }

  /* Directional traveling pulse dot along the work path. */
  const phase = active ? (timeSec * 0.55) % 1 : 0.5;
  const inv = 1 - phase;
  const px = inv * inv * x1 + 2 * inv * phase * mx + phase * phase * x2;
  const py = inv * inv * y1 + 2 * inv * phase * my + phase * phase * y2;
  g.circle(px, py, width * 1.55).fill({ color: 0xffffff, alpha: active ? 0.96 : 0.65 });
  g.circle(px, py, width * 2.25).fill({ color, alpha: active ? 0.42 : 0.2 });

  /* Terminal node marker. */
  g.circle(x2, y2, width * 1.3).fill({ color, alpha: 0.92 });
}

/* PixiJS WebGL overlay for Department Mode:
   dims the non-selected city ground/structures while keeping the selected department's buildings,
   houses, statues, residents and inter-participant work paths brightly lit in its banner color. */
export function renderDepartmentFocusToPixi(
  g: Graphics,
  focus: DepartmentFocusSpec,
  city: CityState,
  residents: readonly ResidentEntity[],
  mapSize: number,
  tileW: number,
  tileH: number,
  zoom: number,
  timeSec: number,
): void {
  const bannerHex = parseHex(focus.bannerColor, 0x2e7bb5);
  const strokeW = Math.max(1.8, 2.6 / Math.max(0.5, zoom));

  /* 1. Soft darkening veil over the full map diamond (dims unfocused city ground & buildings). */
  const top = tileTopVertexToWorld(0, 0, tileW, tileH);
  const right = tileTopVertexToWorld(mapSize, 0, tileW, tileH);
  const bottom = tileTopVertexToWorld(mapSize, mapSize, tileW, tileH);
  const left = tileTopVertexToWorld(0, mapSize, tileW, tileH);
  g.moveTo(top.x, top.y)
    .lineTo(right.x, right.y)
    .lineTo(bottom.x, bottom.y)
    .lineTo(left.x, left.y)
    .closePath()
    .fill({ color: 0x0e0c0a, alpha: 0.42 });

  /* 2. Bright banner-colored footprint highlights + banner pennants on every building in the department. */
  for (const b of city.buildings) {
    if (!focus.highlightedBuildingIds.has(b.id)) continue;
    const bt = tileTopVertexToWorld(b.col, b.row, tileW, tileH);
    const br = tileTopVertexToWorld(b.col + b.spanCol, b.row, tileW, tileH);
    const bb = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, tileW, tileH);
    const bl = tileTopVertexToWorld(b.col, b.row + b.spanRow, tileW, tileH);

    const fillAlpha = b.kind === 'department' ? 0.34 : 0.24;
    g.moveTo(bt.x, bt.y)
      .lineTo(br.x, br.y)
      .lineTo(bb.x, bb.y)
      .lineTo(bl.x, bl.y)
      .closePath()
      .fill({ color: bannerHex, alpha: fillAlpha })
      .stroke({ color: bannerHex, alpha: 0.98, width: strokeW * (b.kind === 'department' ? 1.5 : 1.05) });

    /* Bright inner rim so highlighted structures pop above the dimmed city. */
    g.moveTo(bt.x, bt.y)
      .lineTo(br.x, br.y)
      .lineTo(bb.x, bb.y)
      .lineTo(bl.x, bl.y)
      .closePath()
      .stroke({ color: 0xffffff, alpha: 0.45, width: strokeW * 0.45 });

    /* Banner pennant flagpole at the top corner of highlighted department structures. */
    const poleH = b.kind === 'department' ? 38 : 22;
    g.moveTo(bt.x, bt.y)
      .lineTo(bt.x, bt.y - poleH)
      .stroke({ color: 0xf7ecd2, alpha: 0.95, width: Math.max(1.4, strokeW * 0.7) });
    g.moveTo(bt.x, bt.y - poleH)
      .lineTo(bt.x + (b.kind === 'department' ? 18 : 11), bt.y - poleH + 5)
      .lineTo(bt.x, bt.y - poleH + 10)
      .closePath()
      .fill({ color: bannerHex, alpha: 0.98 });
  }

  /* 3. Work-path lines overlaid on the city map between department participants. */
  const linkW = Math.max(2.0, 2.8 / Math.max(0.5, zoom));
  for (const link of focus.links) {
    const a = tileCenterToWorld(link.from.col, link.from.row, tileW, tileH);
    const b = tileCenterToWorld(link.to.col, link.to.row, tileW, tileH);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < 4) continue;
    const lift = Math.min(72, Math.max(18, dist * 0.16));
    const col = linkColor(link.kind, bannerHex);
    drawDashedArcPixi(g, a.x, a.y - 12, b.x, b.y - 12, lift, col, linkW, link.kind === 'one_shot', timeSec, link.active);
  }

  /* 4. Bright banner-color rings around every resident belonging to this department. */
  for (const r of residents) {
    if (!focus.highlightedResidentIds.has(r.id)) continue;
    const pt = tileCenterToWorld(r.col, r.row, tileW, tileH);
    g.ellipse(pt.x, pt.y + 1, 14, 7.5)
      .fill({ color: bannerHex, alpha: 0.36 })
      .stroke({ color: bannerHex, alpha: 0.98, width: strokeW * 0.9 });
    g.ellipse(pt.x, pt.y + 1, 10, 5.2).stroke({ color: 0xffffff, alpha: 0.7, width: Math.max(1, strokeW * 0.4) });
  }
}

/* Canvas 2D fallback overlay for Department Mode (identical visual semantics). */
export function renderDepartmentFocusFallback2D(
  ctx: CanvasRenderingContext2D,
  focus: DepartmentFocusSpec,
  city: CityState,
  residents: readonly ResidentEntity[],
  mapSize: number,
  tileW: number,
  tileH: number,
  zoom: number,
): void {
  const top = tileTopVertexToWorld(0, 0, tileW, tileH);
  const right = tileTopVertexToWorld(mapSize, 0, tileW, tileH);
  const bottom = tileTopVertexToWorld(mapSize, mapSize, tileW, tileH);
  const left = tileTopVertexToWorld(0, mapSize, tileW, tileH);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(right.x, right.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.lineTo(left.x, left.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(14, 12, 10, 0.42)';
  ctx.fill();

  const strokeW = Math.max(1.8, 2.6 / Math.max(0.5, zoom));
  for (const b of city.buildings) {
    if (!focus.highlightedBuildingIds.has(b.id)) continue;
    const bt = tileTopVertexToWorld(b.col, b.row, tileW, tileH);
    const br = tileTopVertexToWorld(b.col + b.spanCol, b.row, tileW, tileH);
    const bb = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, tileW, tileH);
    const bl = tileTopVertexToWorld(b.col, b.row + b.spanRow, tileW, tileH);
    ctx.beginPath();
    ctx.moveTo(bt.x, bt.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bb.x, bb.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.globalAlpha = b.kind === 'department' ? 0.34 : 0.24;
    ctx.fillStyle = focus.bannerColor;
    ctx.fill();
    ctx.globalAlpha = 0.98;
    ctx.strokeStyle = focus.bannerColor;
    ctx.lineWidth = strokeW * (b.kind === 'department' ? 1.5 : 1.05);
    ctx.stroke();
  }

  for (const link of focus.links) {
    const a = tileCenterToWorld(link.from.col, link.from.row, tileW, tileH);
    const b = tileCenterToWorld(link.to.col, link.to.row, tileW, tileH);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < 4) continue;
    const lift = Math.min(72, Math.max(18, dist * 0.16));
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5 - lift - 12;
    ctx.beginPath();
    ctx.setLineDash(link.kind === 'one_shot' ? [8, 6] : []);
    ctx.moveTo(a.x, a.y - 12);
    ctx.quadraticCurveTo(mx, my, b.x, b.y - 12);
    ctx.globalAlpha = link.active ? 0.95 : 0.72;
    ctx.strokeStyle = linkCss(link.kind, focus.bannerColor);
    ctx.lineWidth = Math.max(2, 2.8 / Math.max(0.5, zoom));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const r of residents) {
    if (!focus.highlightedResidentIds.has(r.id)) continue;
    const pt = tileCenterToWorld(r.col, r.row, tileW, tileH);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 1, 14, 7.5, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.36;
    ctx.fillStyle = focus.bannerColor;
    ctx.fill();
    ctx.globalAlpha = 0.98;
    ctx.strokeStyle = focus.bannerColor;
    ctx.lineWidth = strokeW;
    ctx.stroke();
  }
  ctx.restore();
}
