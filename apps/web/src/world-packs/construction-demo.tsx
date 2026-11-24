/* Stage 6 interactive construction, monuments, demolition and relocation showcase & timelapse studio:
   runs on IsometricWorldEngine with both Egypt and Dungeon packs, demonstrating all 10 pack-driven
   construction stages (stakes & rope -> open interior rooms -> scaffold & ramp -> roof beams -> upgraded),
   active building animation loops (crane, hoist block, dust, smoke, water, awning, celebration) and
   work slots (interior masons, scaffold hammerers, ramp carriers, 2-worker sled team), 20-stage statue
   alleys, tiered goal pyramids with golden capstone celebration, reverse-order demolition (10 -> 0),
   and stage-by-stage God's Word relocation. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CityBuilding, CityState, RoadTile } from '../world/city-layout';
import {
  computeStatueAlleyProgress,
  createConstructionSimulation,
  type BuildingConstructionState,
  type ConstructionSimulation,
} from '../world/construction';
import { resolveConstructionStages, type WorldPackManifest } from '../world/manifest';
import { IsometricWorldEngine, type WorldEngineStats } from '../world/renderer';
import { generateWorldTerrain, type GeneratedWorldMap } from '../world/terrain-engine';
import { registeredWorldPacks, worldPackFromParam } from './registry';
import { packText } from '../world/pack-text';
import { loadEveryPackTexts } from './pack-text-load';

/* A demo page shows a pack's words in the language its own switch picks, so every language is at hand. */
loadEveryPackTexts();

type PackKey = string;
type DemoMode = 'build' | 'demolish';
type LangKey = 'ru' | 'en';

const PACKS: Readonly<Record<PackKey, WorldPackManifest>> = Object.fromEntries(registeredWorldPacks().map(p => [p.id, p]));

const TEXT = {
  ru: {
    title: 'Этап 6. Стройка, памятники, снос и перестройка',
    modes: {
      build: 'Стройка: здание (10), статуи (20), пирамида',
      demolish: 'Снос (10 -> 0) и перестройка по слову бога',
    },
    play: 'Пуск',
    pause: 'Пауза',
    replay: 'Сначала',
    buildingLabel: 'Здание отдела',
    statueLabel: 'Аллея статуй',
    monumentLabel: 'Пирамида цели',
    demolishLabel: 'Снос в обратном порядке',
    relocateOldLabel: 'Старое место (снос)',
    relocateNewLabel: 'Новое место (стройка)',
    cleared: 'Площадка расчищена (0/10)',
    celebrating: 'Золотой пирамидион и праздник',
    tier: 'Ярус',
    stage: 'Стадия',
    doneCount: 'готово',
  },
  en: {
    title: 'Stage 6. Construction, Monuments, Demolition & Relocation',
    modes: {
      build: 'Build: Building (10), Statues (20), Pyramid',
      demolish: 'Demolition (10 -> 0) & God\'s Word Relocation',
    },
    play: 'Play',
    pause: 'Pause',
    replay: 'Replay',
    buildingLabel: 'Department Building',
    statueLabel: 'Statue Alley',
    monumentLabel: 'Goal Monument',
    demolishLabel: 'Reverse Demolition',
    relocateOldLabel: 'Old Plot (Demolishing)',
    relocateNewLabel: 'New Plot (Building)',
    cleared: 'Site cleared (0/10)',
    celebrating: 'Golden Capstone & Celebration',
    tier: 'Tier',
    stage: 'Stage',
    doneCount: 'done',
  },
} as const;

type Stage6Readout = {
  mode: DemoMode;
  pack: PackKey;
  progress: number;
  buildingStage: number;
  buildingStageId: string;
  statueStage: number;
  statuesCompleted: number;
  monumentTier: number;
  monumentReached: boolean;
  demolishStage: number;
  relocateOldStage: number;
  relocateNewStage: number;
};

type Stage6DebugHandle = {
  getStats: () => WorldEngineStats | null;
  getState: () => Stage6Readout;
  setProgress: (p: number) => void;
  setPlaying: (playing: boolean) => void;
  setMode: (mode: DemoMode) => void;
  setPack: (pack: PackKey) => void;
  setZoom: (zoom: number) => void;
  centerOn: (target: 'plaza' | 'building' | 'statues' | 'pyramid' | 'demolish' | 'relocate', zoom?: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
};

declare global {
  interface Window {
    __WORLD_STAGE6__?: Stage6DebugHandle;
  }
}

function readParams(): { pack: PackKey; mode: DemoMode; lang: LangKey; zoom: number; autoplay: boolean } {
  const sp = new URLSearchParams(window.location.search);
  const pack: PackKey = worldPackFromParam(sp.get('pack')).id;
  const mode: DemoMode = sp.get('mode') === 'demolish' ? 'demolish' : 'build';
  const lang: LangKey = sp.get('lang') === 'en' ? 'en' : 'ru';
  const zRaw = Number(sp.get('zoom') ?? '100');
  const zoom = Number.isFinite(zRaw) ? Math.max(0.5, Math.min(2.0, zRaw / 100)) : 1.0;
  const autoplay = sp.get('autoplay') !== '0';
  return { pack, mode, lang, zoom, autoplay };
}

function makeRoadStrip(roads: Map<string, RoadTile>, c0: number, r0: number, c1: number, r1: number): void {
  const dc = Math.sign(c1 - c0);
  const dr = Math.sign(r1 - r0);
  let c = c0;
  let r = r0;
  for (let guard = 0; guard < 40; guard++) {
    roads.set(`${c},${r}`, {
      col: c,
      row: r,
      tier: 'stone',
      traffic: 40,
      bridge: false,
      wasOldWall: false,
      grandAvenue: true,
    });
    if (c === c1 && r === r1) break;
    if (c !== c1) c += dc;
    else if (r !== r1) r += dr;
  }
}

function findDryPlazaCenter(map: GeneratedWorldMap): { col: number; row: number } {
  const isClear = (c: number, r: number): boolean => {
    if (c < 12 || r < 12 || c >= map.baseSize - 12 || r >= map.baseSize - 12) return false;
    const tileId = map.tileAt(c, r);
    const kind = tileId ? map.kindById.get(tileId) : undefined;
    if (!kind) return true;
    return !kind.liquid && (kind.buildable || Boolean(kind.excavatable));
  };
  const fitsPlaza = (cx: number, cy: number): boolean => {
    for (let dr = -8; dr <= 8; dr += 2) {
      for (let dc = -8; dc <= 8; dc += 2) {
        if (!isClear(cx + dc, cy + dr)) return false;
      }
    }
    return true;
  };
  const base = map.startCenter;
  if (fitsPlaza(base.col, base.row)) return { col: base.col, row: base.row };
  for (let rad = 2; rad <= 36; rad += 2) {
    for (let dr = -rad; dr <= rad; dr += 2) {
      for (let dc = -rad; dc <= rad; dc += 2) {
        if (Math.abs(dc) !== rad && Math.abs(dr) !== rad) continue;
        if (fitsPlaza(base.col + dc, base.row + dr)) {
          return { col: base.col + dc, row: base.row + dr };
        }
      }
    }
  }
  return { col: base.col, row: base.row };
}

/* Builds a clean, unoccluded ceremonial plaza centered at a dry buildable anchor for Stage 6 timelapse demos. */
function buildStage6ShowcaseCity(
  pack: WorldPackManifest,
  centerCol: number,
  centerRow: number,
  mode: DemoMode,
  progress: number,
): {
  city: CityState;
  sim: ConstructionSimulation;
  readout: Stage6Readout;
  anchors: Record<'plaza' | 'building' | 'statues' | 'pyramid' | 'demolish' | 'relocate', { col: number; row: number }>;
} {
  const p = Math.max(0, Math.min(1, progress));
  const stages = resolveConstructionStages(pack);
  const roads = new Map<string, RoadTile>();
  const buildings: CityBuilding[] = [];
  const footprintOccupant = new Map<string, string>();
  const sim = createConstructionSimulation(pack);

  const registerFootprint = (b: CityBuilding) => {
    for (let dc = 0; dc < b.spanCol; dc++) {
      for (let dr = 0; dr < b.spanRow; dr++) {
        footprintOccupant.set(`${b.col + dc},${b.row + dr}`, b.id);
      }
    }
  };

  /* Stone promenade avenues crossing the showcase plaza. */
  makeRoadStrip(roads, centerCol - 9, centerRow + 2, centerCol + 11, centerRow + 2);
  makeRoadStrip(roads, centerCol + 1, centerRow - 7, centerCol + 1, centerRow + 9);
  makeRoadStrip(roads, centerCol - 6, centerRow - 3, centerCol + 8, centerRow - 3);

  let buildingStage = 1;
  let statueStage = 1;
  let statuesCompleted = 0;
  let monumentTier = 1;
  let monumentReached = false;
  let demolishStage = 10;
  let relocateOldStage = 10;
  let relocateNewStage = 1;

  const anchors = {
    plaza: mode === 'demolish' ? { col: centerCol, row: centerRow + 1 } : { col: centerCol, row: centerRow },
    building: { col: centerCol - 4, row: centerRow + 5 },
    statues: { col: centerCol + 5, row: centerRow + 5 },
    pyramid: { col: centerCol + 3, row: centerRow - 5 },
    demolish: { col: centerCol - 3, row: centerRow + 2 },
    relocate: { col: centerCol + 1, row: centerRow + 1 },
  };

  const baseBuildingFields = {
    residentIds: [] as string[],
    mergedFromIds: [] as string[],
    goalCount: 0,
    placedAtStep: 1,
  };

  if (mode === 'build') {
    /* 1. Department Building progressing smoothly through all 10 pack stages (1..10). */
    buildingStage = Math.max(1, Math.min(10, Math.floor(p * 10) + 1));
    const deptB: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-dept',
      kind: 'department',
      label: 'Development Hall',
      col: centerCol - 6,
      row: centerRow + 3,
      spanCol: 4,
      spanRow: 4,
      door: { col: centerCol - 4, row: centerRow + 2 },
      lot: { col: centerCol - 7, row: centerRow + 2, spanCol: 6, spanRow: 6 },
      stage: buildingStage,
      maxStage: 10,
      level: buildingStage,
      floors: buildingStage >= 10 ? 2 : 1,
      departmentId: 'dept-dev',
    };
    buildings.push(deptB);
    registerFootprint(deptB);

    const deptJob: BuildingConstructionState = {
      id: 'job-dept',
      buildingId: deptB.id,
      buildingSnapshot: { ...deptB },
      kind: 'department',
      col: deptB.col,
      row: deptB.row,
      spanCol: deptB.spanCol,
      spanRow: deptB.spanRow,
      phase: buildingStage >= 9 ? 'complete' : 'building',
      currentStage: buildingStage,
      targetStage: 10,
      maxStage: 10,
      stageProgress: (p * 10) % 1,
      stagesPerSec: 0,
      stageHistory: [buildingStage],
    };
    sim.jobs.set(deptB.id, deptJob);

    /* 2. Statue Alley: 20 stages per statue (0..3,400 tasks simulated -> Statue #1 finishes 20/20,
       stays permanently, and Statue #2 grows larger 2x2 right beside it!). */
    const simTasks = Math.round(100 + p * 3300);
    const alley = computeStatueAlleyProgress(simTasks, 20, 100);
    statuesCompleted = alley.filter(a => a.completed).length;
    const latestStatue = alley[alley.length - 1]!;
    statueStage = latestStatue.stage;

    alley.forEach((st, idx) => {
      const colOff = idx === 0 ? 3 : idx === 1 ? 5 : 8;
      const sb: CityBuilding = {
        ...baseBuildingFields,
        id: `stage6-statue-${idx}`,
        kind: 'statue',
        label: `Statue #${idx + 1}`,
        col: centerCol + colOff,
        row: centerRow + 4,
        spanCol: st.span,
        spanRow: st.span,
        door: { col: centerCol + colOff, row: centerRow + 3 },
        lot: {
          col: centerCol + colOff,
          row: centerRow + 4,
          spanCol: st.span,
          spanRow: st.span,
        },
        stage: st.stage,
        maxStage: 20,
        level: st.stage,
        floors: 1,
        reached: st.completed,
        departmentId: 'dept-dev',
      };
      buildings.push(sb);
      registerFootprint(sb);
      sim.jobs.set(sb.id, {
        id: `job-${sb.id}`,
        buildingId: sb.id,
        buildingSnapshot: { ...sb },
        kind: 'statue',
        col: sb.col,
        row: sb.row,
        spanCol: sb.spanCol,
        spanRow: sb.spanRow,
        phase: st.completed ? 'complete' : 'building',
        currentStage: st.stage,
        targetStage: 20,
        maxStage: 20,
        stageProgress: 0,
        stagesPerSec: 0,
        stageHistory: [st.stage],
      });
    });

    /* 3. Tiered Goal Pyramid (5x5): grows 1..10 tiers with ramp, sled team & crane,
       then caps with gleaming golden capstone & celebration loop at p >= 0.88! */
    monumentReached = p >= 0.88;
    monumentTier = monumentReached ? 10 : Math.max(1, Math.min(9, Math.floor((p / 0.88) * 9) + 1));
    const pyrB: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-pyramid',
      kind: 'monument',
      label: 'Primary Goal Monument',
      col: centerCol + 1,
      row: centerRow - 7,
      spanCol: 5,
      spanRow: 5,
      door: { col: centerCol + 3, row: centerRow - 2 },
      lot: { col: centerCol, row: centerRow - 8, spanCol: 7, spanRow: 7 },
      stage: monumentTier,
      maxStage: 10,
      level: monumentTier,
      floors: 1,
      progress: monumentReached ? 1 : monumentTier / 10,
      reached: monumentReached,
    };
    buildings.push(pyrB);
    registerFootprint(pyrB);
    sim.jobs.set(pyrB.id, {
      id: 'job-pyramid',
      buildingId: pyrB.id,
      buildingSnapshot: { ...pyrB },
      kind: 'monument',
      col: pyrB.col,
      row: pyrB.row,
      spanCol: pyrB.spanCol,
      spanRow: pyrB.spanRow,
      phase: monumentReached ? 'complete' : 'building',
      currentStage: monumentTier,
      targetStage: 10,
      maxStage: 10,
      stageProgress: 0,
      stagesPerSec: 0,
      stageHistory: [monumentTier],
    });

    /* 4. Live Supply Well with shimmering water ripples & fluttering awning. */
    const wellB: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-supply',
      kind: 'supply',
      label: 'Plan Well',
      col: centerCol - 4,
      row: centerRow - 6,
      spanCol: 2,
      spanRow: 2,
      door: { col: centerCol - 3, row: centerRow - 3 },
      lot: { col: centerCol - 5, row: centerRow - 7, spanCol: 4, spanRow: 4 },
      stage: 5,
      maxStage: 5,
      level: 5,
      floors: 1,
      fullness: 0.82,
      provider: 'codex',
    };
    buildings.push(wellB);
    registerFootprint(wellB);
  } else {
    /* Mode B: Reverse Demolition (10 -> 0) on the left + God's Word Stage-by-Stage Relocation on the right! */
    demolishStage = Math.max(0, 10 - Math.floor(p * 11));
    const demB: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-demolish',
      kind: 'department',
      label: 'Old Workshop',
      col: centerCol - 5,
      row: centerRow + 1,
      spanCol: 4,
      spanRow: 4,
      door: { col: centerCol - 3, row: centerRow + 5 },
      lot: { col: centerCol - 6, row: centerRow, spanCol: 6, spanRow: 6 },
      stage: demolishStage,
      maxStage: 10,
      level: 10,
      floors: 2,
      departmentId: 'dept-old',
    };
    buildings.push(demB);
    if (demolishStage > 0) registerFootprint(demB);
    sim.jobs.set(demB.id, {
      id: 'job-demolish',
      buildingId: demB.id,
      buildingSnapshot: { ...demB },
      kind: 'department',
      col: demB.col,
      row: demB.row,
      spanCol: demB.spanCol,
      spanRow: demB.spanRow,
      phase: demolishStage <= 0 ? 'cleared' : 'demolishing',
      currentStage: demolishStage,
      targetStage: 0,
      maxStage: 10,
      stageProgress: 0,
      stagesPerSec: 0,
      stageHistory: [demolishStage],
    });

    /* God's Word Relocation: old plot dismantles 10 -> 0 (first 65% of timeline),
       new plot builds 1 -> 10 (starts at 25% of timeline -> completes at 100%)! */
    const oldP = Math.min(1, p / 0.68);
    relocateOldStage = Math.max(0, 10 - Math.floor(oldP * 11));
    const newP = Math.max(0, (p - 0.2) / 0.8);
    relocateNewStage = Math.max(1, Math.min(10, Math.floor(newP * 10) + 1));

    const relOld: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-reloc__old',
      kind: 'house',
      label: 'Relocating Villa (Old)',
      col: centerCol + 1,
      row: centerRow - 4,
      spanCol: 3,
      spanRow: 3,
      door: { col: centerCol + 2, row: centerRow - 1 },
      lot: { col: centerCol, row: centerRow - 5, spanCol: 5, spanRow: 5 },
      stage: relocateOldStage,
      maxStage: 10,
      level: 9,
      floors: 2,
      provider: 'claude',
      districtId: 'mac-main',
      pendingRelocation:
        relocateOldStage > 0
          ? { relocationId: 'rel-demo', taskId: 'task-1810', taskNumber: 1810, toCol: centerCol + 2, toRow: centerRow + 2 }
          : null,
    };
    const relNew: CityBuilding = {
      ...baseBuildingFields,
      id: 'stage6-reloc',
      kind: 'house',
      label: 'Relocating Villa (New)',
      col: centerCol + 2,
      row: centerRow + 2,
      spanCol: 3,
      spanRow: 3,
      door: { col: centerCol + 3, row: centerRow + 5 },
      lot: { col: centerCol + 1, row: centerRow + 1, spanCol: 5, spanRow: 5 },
      stage: relocateNewStage,
      maxStage: 10,
      level: 9,
      floors: 2,
      provider: 'claude',
      districtId: 'mac-main',
    };
    buildings.push(relOld, relNew);
    if (relocateOldStage > 0) registerFootprint(relOld);
    registerFootprint(relNew);

    sim.jobs.set(relOld.id, {
      id: 'job-reloc-old',
      buildingId: relOld.id,
      buildingSnapshot: { ...relOld },
      kind: 'house',
      col: relOld.col,
      row: relOld.row,
      spanCol: relOld.spanCol,
      spanRow: relOld.spanRow,
      phase: relocateOldStage <= 0 ? 'cleared' : 'demolishing',
      currentStage: relocateOldStage,
      targetStage: 0,
      maxStage: 10,
      stageProgress: 0,
      stagesPerSec: 0,
      stageHistory: [relocateOldStage],
    });
    sim.jobs.set(relNew.id, {
      id: 'job-reloc-new',
      buildingId: relNew.id,
      buildingSnapshot: { ...relNew },
      kind: 'house',
      col: relNew.col,
      row: relNew.row,
      spanCol: relNew.spanCol,
      spanRow: relNew.spanRow,
      phase: relocateNewStage >= 9 ? 'complete' : 'building',
      currentStage: relocateNewStage,
      targetStage: 10,
      maxStage: 10,
      stageProgress: 0,
      stagesPerSec: 0,
      stageHistory: [relocateNewStage],
    });
  }

  const city: CityState = {
    seed: 'stage6-showcase',
    packId: pack.id,
    baseSize: pack.mapSize,
    orderChaos: 0.85,
    outerWallMode: pack.outerWallMode ?? 'ring',
    buildingLayout: pack.buildingLayout ?? {},
    center: { col: centerCol, row: centerRow },
    stepCounter: 1,
    wallGeneration: 0,
    wallHull: null,
    buildings,
    roads,
    wallTiles: new Set(),
    excavatedTiles: new Set(),
    relocations: [],
    vacatedLots: [],
    footprintOccupant,
    lotReservation: new Map(),
    metrics: {
      roadStraightness: 1,
      gridAlignmentRatio: 1,
      densifiedUpgrades: 0,
      mergedBuildings: 0,
      oldWallRoadsCreated: 0,
      bridgeTiles: 0,
      excavatedCount: 0,
    },
    rngState: 1,
  };

  const activeStageSpec = stages[Math.max(0, Math.min(stages.length - 1, buildingStage - 1))]!;
  return {
    city,
    sim,
    anchors,
    readout: {
      mode,
      pack: pack.id,
      progress: Math.round(p * 1000) / 1000,
      buildingStage,
      buildingStageId: activeStageSpec.id,
      statueStage,
      statuesCompleted,
      monumentTier,
      monumentReached,
      demolishStage,
      relocateOldStage,
      relocateNewStage,
    },
  };
}

function Stage6ConstructionStudio() {
  const initial = useMemo(() => readParams(), []);
  const [packKey, setPackKey] = useState<PackKey>(initial.pack);
  const [mode, setMode] = useState<DemoMode>(initial.mode);
  const [lang, setLang] = useState<LangKey>(initial.lang);
  const [playing, setPlaying] = useState<boolean>(initial.autoplay);
  const [progress, setProgress] = useState<number>(0);
  const [stats, setStats] = useState<WorldEngineStats | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IsometricWorldEngine | null>(null);
  const anchorsRef = useRef<Record<'plaza' | 'building' | 'statues' | 'pyramid' | 'demolish' | 'relocate', { col: number; row: number }> | null>(null);
  const readoutRef = useRef<Stage6Readout | null>(null);

  const pack = PACKS[packKey];
  const t = TEXT[lang];
  const stages = useMemo(() => resolveConstructionStages(pack), [pack]);

  /* Generate terrain & dry plaza anchor synchronously per pack so initial camera & anchors never lag! */
  const { terrainMap, dryCenter } = useMemo(() => {
    const map = generateWorldTerrain(pack, { seed: 'hornhoof-team-2026', mapSize: pack.mapSize });
    return { terrainMap: map, dryCenter: findDryPlazaCenter(map) };
  }, [pack]);

  const builtState = useMemo(
    () => buildStage6ShowcaseCity(pack, dryCenter.col, dryCenter.row, mode, progress),
    [pack, dryCenter, mode, progress],
  );
  anchorsRef.current = builtState.anchors;
  readoutRef.current = builtState.readout;

  /* Smooth continuous playback timer when playing. */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setProgress(prev => {
        const next = prev + dt * 0.11;
        return next > 1 ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /* Mount IsometricWorldEngine per pack. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;

    const initialBuilt = buildStage6ShowcaseCity(pack, dryCenter.col, dryCenter.row, mode, progress);

    void IsometricWorldEngine.create({
      host,
      pack,
      terrainMap,
      showBuildGrid: false,
      initialZoom: initial.zoom,
      initialCenterTile: initialBuilt.anchors.plaza,
      onStats: next => {
        if (alive) setStats(next);
      },
    }).then(engine => {
      if (!alive) {
        engine.destroy();
        return;
      }
      engineRef.current = engine;
      engine.setCityRenderState({
        city: initialBuilt.city,
        worldMode: 'active',
        districtColors: { 'mac-main': '#4DA167' },
      });
      engine.setConstructionSimulation(initialBuilt.sim);
      engine.flushVisibleBakes();
      setStats(engine.getStats());

      window.__WORLD_STAGE6__ = {
        getStats: () => engineRef.current?.getStats() ?? null,
        getState: () => readoutRef.current!,
        setProgress: p => {
          setPlaying(false);
          setProgress(Math.max(0, Math.min(1, p)));
        },
        setPlaying: flag => setPlaying(flag),
        setMode: m => setMode(m),
        setPack: pk => setPackKey(pk),
        setZoom: z => engineRef.current?.setZoom(z),
        centerOn: (target, zoom) => {
          const anchor = anchorsRef.current?.[target];
          if (!anchor || !engineRef.current) return;
          engineRef.current.centerOnTile(anchor, zoom);
          engineRef.current.flushVisibleBakes();
        },
        panByScreen: (dx, dy) => engineRef.current?.panByScreen(dx, dy),
        flushVisibleBakes: () => engineRef.current?.flushVisibleBakes(),
      };
    });

    return () => {
      alive = false;
      delete window.__WORLD_STAGE6__;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [pack, terrainMap, dryCenter]);

  /* Sync progress & mode updates onto the live engine without remounting PixiJS. */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setCityRenderState({
      city: builtState.city,
      worldMode: 'active',
      districtColors: { 'mac-main': '#4DA167' },
    });
    engine.setConstructionSimulation(builtState.sim);
  }, [builtState]);

  const currentStageSpec = stages[Math.max(0, Math.min(stages.length - 1, builtState.readout.buildingStage - 1))]!;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: pack.palette.backdrop }}>
      <div ref={hostRef} data-testid="world-stage6-canvas" style={{ position: 'absolute', inset: 0 }} />

      {/* Top toolbar */}
      <div
        data-testid="world-stage6-topbar"
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          right: 12,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 12,
          background: 'rgba(18, 16, 13, 0.9)',
          border: '1px solid rgba(226, 200, 146, 0.3)',
          color: '#F3EAD7',
          fontSize: 13,
          zIndex: 10,
        }}
      >
        <strong style={{ color: '#F3D28A', fontSize: 14 }}>{t.title}</strong>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select
            aria-label="Showcase Mode"
            data-testid="world-stage6-mode"
            value={mode}
            onChange={e => {
              setMode(e.target.value as DemoMode);
              setProgress(0);
            }}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
            }}
          >
            <option value="build">{t.modes.build}</option>
            <option value="demolish">{t.modes.demolish}</option>
          </select>

          <select
            aria-label="World Pack"
            data-testid="world-stage6-pack"
            value={packKey}
            onChange={e => setPackKey(e.target.value)}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
            }}
          >
            {registeredWorldPacks().map(p => (
              <option key={p.id} value={p.id}>
                {packText(p.name, lang)}
              </option>
            ))}
          </select>

          <button
            type="button"
            data-testid="world-stage6-play"
            onClick={() => setPlaying(pl => !pl)}
            style={{
              background: playing ? '#3F6E54' : '#D9A648',
              color: playing ? '#F3EAD7' : '#1A140B',
              border: 'none',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {playing ? t.pause : t.play}
          </button>

          <button
            type="button"
            onClick={() => setProgress(0)}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 9px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t.replay}
          </button>

          <input
            aria-label="Timeline Progress"
            data-testid="world-stage6-slider"
            type="range"
            min={0}
            max={100}
            value={Math.round(progress * 100)}
            onChange={e => {
              setPlaying(false);
              setProgress(Number(e.target.value) / 100);
            }}
            style={{ width: 120 }}
          />

          <button
            type="button"
            onClick={() => setLang(l => (l === 'ru' ? 'en' : 'ru'))}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {lang.toUpperCase()}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <button
              type="button"
              onClick={() => engineRef.current?.zoomOut()}
              style={{
                background: '#24201A',
                color: '#F3EAD7',
                border: '1px solid rgba(226, 200, 146, 0.34)',
                borderRadius: 6,
                width: 26,
                height: 26,
                cursor: 'pointer',
              }}
            >
              -
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.resetZoom()}
              style={{
                background: '#24201A',
                color: '#F3EAD7',
                border: '1px solid rgba(226, 200, 146, 0.34)',
                borderRadius: 6,
                padding: '0 8px',
                height: 26,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {stats ? `${stats.zoomPercent}%` : '100%'}
            </button>
            <button
              type="button"
              onClick={() => engineRef.current?.zoomIn()}
              style={{
                background: '#24201A',
                color: '#F3EAD7',
                border: '1px solid rgba(226, 200, 146, 0.34)',
                borderRadius: 6,
                width: 26,
                height: 26,
                cursor: 'pointer',
              }}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Bottom stage readout HUD */}
      <div
        data-testid="world-stage6-readout"
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          right: 12,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '8px 14px',
          borderRadius: 10,
          background: 'rgba(18, 16, 13, 0.88)',
          border: '1px solid rgba(226, 200, 146, 0.28)',
          color: '#ECE2CC',
          fontSize: 12,
          zIndex: 10,
        }}
      >
        {mode === 'build' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <span>
              {t.buildingLabel}:{' '}
              <strong style={{ color: '#F3D28A' }}>
                {builtState.readout.buildingStage}/10 ({packText(currentStageSpec.label, lang)})
              </strong>
            </span>
            <span>
              {t.statueLabel}:{' '}
              <strong style={{ color: '#A9D6FF' }}>
                {t.stage} {builtState.readout.statueStage}/20 ({t.doneCount}: {builtState.readout.statuesCompleted})
              </strong>
            </span>
            <span>
              {t.monumentLabel}:{' '}
              <strong style={{ color: builtState.readout.monumentReached ? '#FFE474' : '#E8CFA0' }}>
                {builtState.readout.monumentReached
                  ? t.celebrating
                  : `${t.tier} ${builtState.readout.monumentTier}/10`}
              </strong>
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <span>
              {t.demolishLabel}:{' '}
              <strong style={{ color: '#F09A7A' }}>
                {builtState.readout.demolishStage <= 0
                  ? t.cleared
                  : `${t.stage} ${builtState.readout.demolishStage}/10`}
              </strong>
            </span>
            <span>
              {t.relocateOldLabel}:{' '}
              <strong style={{ color: '#F09A7A' }}>
                {builtState.readout.relocateOldStage <= 0
                  ? t.cleared
                  : `${builtState.readout.relocateOldStage}/10`}
              </strong>
            </span>
            <span>
              {t.relocateNewLabel}:{' '}
              <strong style={{ color: '#9BE0B0' }}>
                {builtState.readout.relocateNewStage}/10
              </strong>
            </span>
          </div>
        )}

        {stats && (
          <span>
            {Math.round(progress * 100)}% | {stats.fps} FPS ({stats.rendererKind})
          </span>
        )}
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Stage6ConstructionStudio />);
}
