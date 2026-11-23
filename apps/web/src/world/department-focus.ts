/* Pack-agnostic Department Mode focus builder and overlay renderer for Stage 8.
   Highlights all buildings and residents belonging to the selected department in its banner color,
   dims the rest of the city softly, and draws only clean road-following street routes between
   department structures (never straight diagonals across roofs/water and never lines to walking agents).
   Contains zero theme-specific words. */

import type { Graphics } from 'pixi.js';
import { tileKey, type CityBuilding, type CityState } from './city-layout';
import { tileCenterToWorld, tileTopVertexToWorld, type TileCoord } from './coords';
import type { ResidentEntity } from './residents';

export type DepartmentWorkLinkKind = 'handoff' | 'statue' | 'one_shot';

export type DepartmentWorkLink = Readonly<{
  id: string;
  kind: DepartmentWorkLinkKind;
  from: TileCoord;
  to: TileCoord;
  /* Ordered street tiles strictly inside city.roads along which this route runs. */
  path: readonly TileCoord[];
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

/* Collects existing road tiles around a building footprint (checking radius 1, 2, then 3). */
function roadEntrancesForBuilding(city: CityState, b: CityBuilding): TileCoord[] {
  for (const pad of [1, 2, 3]) {
    const out: TileCoord[] = [];
    const seen = new Set<string>();
    const minC = b.col - pad;
    const maxC = b.col + b.spanCol - 1 + pad;
    const minR = b.row - pad;
    const maxR = b.row + b.spanRow - 1 + pad;
    for (let c = minC; c <= maxC; c++) {
      for (let r = minR; r <= maxR; r++) {
        if (c >= b.col && c < b.col + b.spanCol && r >= b.row && r < b.row + b.spanRow) continue;
        const k = tileKey(c, r);
        if (seen.has(k) || !city.roads.has(k)) continue;
        seen.add(k);
        out.push({ col: c, row: r });
      }
    }
    if (out.length > 0) {
      const refCol = b.door?.col ?? b.col + b.spanCol * 0.5;
      const refRow = b.door?.row ?? b.row + b.spanRow * 0.5;
      out.sort(
        (a, c) =>
          Math.abs(a.col - refCol) + Math.abs(a.row - refRow) -
          (Math.abs(c.col - refCol) + Math.abs(c.row - refRow)),
      );
      return out;
    }
  }
  return [];
}

const ROAD_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/* Shortest path strictly along city.roads tiles between two buildings' front-door street entrances. */
function findRoadPathBetweenBuildings(
  city: CityState,
  fromBld: CityBuilding,
  toBld: CityBuilding,
  maxVisited = 4000,
): TileCoord[] {
  const starts = roadEntrancesForBuilding(city, fromBld);
  const targets = roadEntrancesForBuilding(city, toBld);
  if (starts.length === 0 || targets.length === 0) return [];

  const start = starts[0]!;
  const startKey = tileKey(start.col, start.row);
  let target = targets.find(t => tileKey(t.col, t.row) !== startKey) ?? targets[0]!;
  let targetKey = tileKey(target.col, target.row);

  /* If two adjacent structures share the exact same single road tile, extend one step along the road. */
  if (targetKey === startKey) {
    for (const [dc, dr] of ROAD_DIRS) {
      const nc = start.col + dc;
      const nr = start.row + dr;
      if (city.roads.has(tileKey(nc, nr))) {
        target = { col: nc, row: nr };
        targetKey = tileKey(nc, nr);
        break;
      }
    }
  }
  if (targetKey === startKey) return [];

  const parent = new Map<string, string | null>([[startKey, null]]);
  const coordByKey = new Map<string, TileCoord>([[startKey, start]]);
  const queue: string[] = [startKey];

  let head = 0;
  let reachedKey: string | null = null;
  while (head < queue.length && parent.size < maxVisited) {
    const curKey = queue[head++]!;
    if (curKey === targetKey) {
      reachedKey = curKey;
      break;
    }
    const cur = coordByKey.get(curKey)!;
    for (const [dc, dr] of ROAD_DIRS) {
      const nc = cur.col + dc;
      const nr = cur.row + dr;
      const nk = tileKey(nc, nr);
      if (parent.has(nk) || !city.roads.has(nk)) continue;
      parent.set(nk, curKey);
      coordByKey.set(nk, { col: nc, row: nr });
      queue.push(nk);
    }
  }

  if (!reachedKey) return [];
  const reversed: TileCoord[] = [];
  let cursor: string | null = reachedKey;
  while (cursor !== null) {
    reversed.push(coordByKey.get(cursor)!);
    cursor = parent.get(cursor) ?? null;
  }
  reversed.reverse();
  return reversed;
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
  const deptStatues: CityBuilding[] = [];
  const houseByAgentId = new Map<string, CityBuilding>();

  for (const b of city.buildings) {
    if (b.kind === 'flophouse') flophouseBuilding = b;
    if (b.kind === 'monument' && (!monumentBuilding || b.departmentId === departmentId)) {
      monumentBuilding = b;
    }
    if (b.departmentId === departmentId) {
      if (b.kind === 'department') deptBuilding = b;
      if (b.kind === 'statue') deptStatues.push(b);
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
      const house =
        houseByAgentId.get(r.agentId) ??
        (r.homeBuildingId ? city.buildings.find(b => b.id === r.homeBuildingId) : undefined);
      if (house) highlightedBuildingIds.add(house.id);
    }
  }

  const links: DepartmentWorkLink[] = [];
  const hasWorking = deptResidents.some(r => r.liveState === 'working');
  const hasDayLaborers = deptResidents.some(r => r.roleClass === 'day_laborer');

  /* Only build clean, road-following routes between architectural landmarks (zero straight rays to walking agents). */
  if (deptBuilding && monumentBuilding) {
    const path = findRoadPathBetweenBuildings(city, deptBuilding, monumentBuilding);
    if (path.length >= 2) {
      links.push({
        id: `route-dept-monument-${monumentBuilding.id}`,
        kind: 'handoff',
        from: path[0]!,
        to: path[path.length - 1]!,
        path,
        fromLabel: deptBuilding.label,
        toLabel: monumentBuilding.label,
        active: hasWorking,
      });
    }
  }

  if (deptBuilding && deptStatues.length > 0) {
    const statue = deptStatues[deptStatues.length - 1]!;
    const path = findRoadPathBetweenBuildings(city, deptBuilding, statue);
    if (path.length >= 2) {
      links.push({
        id: `route-dept-statue-${statue.id}`,
        kind: 'statue',
        from: path[0]!,
        to: path[path.length - 1]!,
        path,
        fromLabel: deptBuilding.label,
        toLabel: statue.label,
        active: hasWorking,
      });
    }
  }

  if (deptBuilding && flophouseBuilding && hasDayLaborers) {
    const path = findRoadPathBetweenBuildings(city, flophouseBuilding, deptBuilding);
    if (path.length >= 2) {
      highlightedBuildingIds.add(flophouseBuilding.id);
      links.push({
        id: `route-oneshot-${flophouseBuilding.id}`,
        kind: 'one_shot',
        from: path[0]!,
        to: path[path.length - 1]!,
        path,
        fromLabel: flophouseBuilding.label,
        toLabel: deptBuilding.label,
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

/* Verifies that a work route runs strictly tile-by-tile along existing city.roads tiles (4-connected). */
export function isLinkStrictlyOnRoads(city: CityState, link: DepartmentWorkLink): boolean {
  if (link.path.length < 2) return false;
  for (let i = 0; i < link.path.length; i++) {
    const cur = link.path[i]!;
    if (!city.roads.has(tileKey(cur.col, cur.row))) return false;
    if (i > 0) {
      const prev = link.path[i - 1]!;
      const dist = Math.abs(cur.col - prev.col) + Math.abs(cur.row - prev.row);
      if (dist !== 1) return false;
    }
  }
  return true;
}

function linkColor(kind: DepartmentWorkLinkKind, bannerHex: number): number {
  if (kind === 'one_shot') return 0xd49b38;
  return bannerHex;
}

function linkCss(kind: DepartmentWorkLinkKind, bannerColor: string): string {
  if (kind === 'one_shot') return '#D49B38';
  return bannerColor;
}

function drawRoadPathPixi(
  g: Graphics,
  path: readonly TileCoord[],
  tileW: number,
  tileH: number,
  color: number,
  width: number,
  dashed: boolean,
): void {
  if (path.length < 2) return;
  const pts = path.map(t => tileCenterToWorld(t.col, t.row, tileW, tileH));

  /* Soft road-hugging under-glow along the street centerline. */
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    g.lineTo(pts[i]!.x, pts[i]!.y);
  }
  g.stroke({ color, alpha: 0.24, width: width * 2.8, cap: 'round', join: 'round' });

  /* Crisp static street trace (dashed only for one-shot helper routes). */
  if (dashed) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (i % 2 === 1) continue;
      g.moveTo(pts[i]!.x, pts[i]!.y)
        .lineTo(pts[i + 1]!.x, pts[i + 1]!.y)
        .stroke({ color, alpha: 0.88, width, cap: 'round' });
    }
  } else {
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) {
      g.lineTo(pts[i]!.x, pts[i]!.y);
    }
    g.stroke({ color, alpha: 0.86, width, cap: 'round', join: 'round' });
  }

  /* Clean start/end street nodes. */
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  g.circle(start.x, start.y, width * 1.15).fill({ color, alpha: 0.9 });
  g.circle(end.x, end.y, width * 1.35).fill({ color, alpha: 0.95 });
  g.circle(end.x, end.y, width * 0.65).fill({ color: 0xffffff, alpha: 0.85 });
}

/* PixiJS WebGL overlay for Department Mode:
   softly dims unfocused city ground/buildings, highlights department structures & agents gently,
   and illuminates only real road-following routes between department buildings. */
export function renderDepartmentFocusToPixi(
  g: Graphics,
  focus: DepartmentFocusSpec,
  city: CityState,
  residents: readonly ResidentEntity[],
  mapSize: number,
  tileW: number,
  tileH: number,
  zoom: number,
  visibleResidentIds?: ReadonlySet<string>,
): void {
  const bannerHex = parseHex(focus.bannerColor, 0x2e7bb5);
  const strokeW = Math.max(1.6, 2.3 / Math.max(0.5, zoom));

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
    .fill({ color: 0x0e0c0a, alpha: 0.34 });

  /* 2. Road-following routes along actual streets between department landmarks (static, calm). */
  const linkW = Math.max(2.0, 2.6 / Math.max(0.5, zoom));
  for (const link of focus.links) {
    drawRoadPathPixi(g, link.path, tileW, tileH, linkColor(link.kind, bannerHex), linkW, link.kind === 'one_shot');
  }

  /* 3. Banner-colored footprint highlights + pennants on department buildings, statues, and member houses. */
  for (const b of city.buildings) {
    if (!focus.highlightedBuildingIds.has(b.id)) continue;
    const bt = tileTopVertexToWorld(b.col, b.row, tileW, tileH);
    const br = tileTopVertexToWorld(b.col + b.spanCol, b.row, tileW, tileH);
    const bb = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, tileW, tileH);
    const bl = tileTopVertexToWorld(b.col, b.row + b.spanRow, tileW, tileH);

    const fillAlpha = b.kind === 'department' ? 0.3 : 0.2;
    g.moveTo(bt.x, bt.y)
      .lineTo(br.x, br.y)
      .lineTo(bb.x, bb.y)
      .lineTo(bl.x, bl.y)
      .closePath()
      .fill({ color: bannerHex, alpha: fillAlpha })
      .stroke({ color: bannerHex, alpha: 0.96, width: strokeW * (b.kind === 'department' ? 1.45 : 1.0) });

    g.moveTo(bt.x, bt.y)
      .lineTo(br.x, br.y)
      .lineTo(bb.x, bb.y)
      .lineTo(bl.x, bl.y)
      .closePath()
      .stroke({ color: 0xffffff, alpha: 0.42, width: strokeW * 0.4 });

    const poleH = b.kind === 'department' ? 36 : 20;
    g.moveTo(bt.x, bt.y)
      .lineTo(bt.x, bt.y - poleH)
      .stroke({ color: 0xf7ecd2, alpha: 0.94, width: Math.max(1.3, strokeW * 0.65) });
    g.moveTo(bt.x, bt.y - poleH)
      .lineTo(bt.x + (b.kind === 'department' ? 17 : 10), bt.y - poleH + 5)
      .lineTo(bt.x, bt.y - poleH + 10)
      .closePath()
      .fill({ color: bannerHex, alpha: 0.96 });
  }

  /* 4. Gentle ground highlight rings locked 1:1 to currently visible department residents (no lines pointing at agents). */
  for (const r of residents) {
    if (!focus.highlightedResidentIds.has(r.id)) continue;
    if (visibleResidentIds && !visibleResidentIds.has(r.id)) continue;
    const pt = tileCenterToWorld(r.col, r.row, tileW, tileH);
    g.ellipse(pt.x, pt.y + 3, 14, 7.5)
      .fill({ color: bannerHex, alpha: 0.3 })
      .stroke({ color: bannerHex, alpha: 0.92, width: strokeW * 0.85 });
    g.ellipse(pt.x, pt.y + 3, 9.5, 5).stroke({ color: 0xffffff, alpha: 0.65, width: Math.max(1, strokeW * 0.38) });
  }
}

/* Canvas 2D fallback overlay for Department Mode (identical road-following & subtle highlight semantics). */
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
  ctx.fillStyle = 'rgba(14, 12, 10, 0.34)';
  ctx.fill();

  const linkW = Math.max(2, 2.6 / Math.max(0.5, zoom));
  for (const link of focus.links) {
    if (link.path.length < 2) continue;
    const pts = link.path.map(t => tileCenterToWorld(t.col, t.row, tileW, tileH));
    ctx.beginPath();
    ctx.setLineDash(link.kind === 'one_shot' ? [8, 6] : []);
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i]!.x, pts[i]!.y);
    }
    ctx.globalAlpha = 0.86;
    ctx.strokeStyle = linkCss(link.kind, focus.bannerColor);
    ctx.lineWidth = linkW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const strokeW = Math.max(1.6, 2.3 / Math.max(0.5, zoom));
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
    ctx.globalAlpha = b.kind === 'department' ? 0.3 : 0.2;
    ctx.fillStyle = focus.bannerColor;
    ctx.fill();
    ctx.globalAlpha = 0.96;
    ctx.strokeStyle = focus.bannerColor;
    ctx.lineWidth = strokeW * (b.kind === 'department' ? 1.45 : 1.0);
    ctx.stroke();
  }

  for (const r of residents) {
    if (!focus.highlightedResidentIds.has(r.id)) continue;
    const pt = tileCenterToWorld(r.col, r.row, tileW, tileH);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 1, 14, 7.5, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = focus.bannerColor;
    ctx.fill();
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = focus.bannerColor;
    ctx.lineWidth = strokeW * 0.85;
    ctx.stroke();
  }
  ctx.restore();
}
