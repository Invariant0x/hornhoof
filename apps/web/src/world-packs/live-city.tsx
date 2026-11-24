/* Stage 4 + Stage 5 live data isometric world viewer with bilingual RU/EN UI, live Hornhoof API +
   built-in team/empty-lot/no-subscription/150-resident stress scenarios, pack switching (Egypt / Dungeon),
   God's Word relocation confirmation workflow, live animated residents across all 6 role classes and
   7 Hornhoof states, God's Altar waiting shrine, department smoke, offline night districts,
   home scaffolding, Agent Card with rate-limited human wake and open-agent-window link. */

import type {
  ResidentLiveState,
  ResidentRoleClass,
  WorldLiveSnapshot,
  WorldRelocationRecord,
} from '@hornhoof/protocol/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorldArtStats } from '../world/art-runtime';
import type { CityBuilding, CityState } from '../world/city-layout';
import type { PickResult, TileCoord } from '../world/coords';
import {
  canRelocateBuildingTo,
  createEmptyCompanyFixture,
  createHornhoofLiveFixture,
  createNoSubscriptionFixture,
  createStress150LiveFixture,
  syncLiveSnapshotToCity,
  type LiveCitySummary,
  type LiveCitySyncResult,
} from '../world/live-sync';
import type { WorldPackManifest } from '../world/manifest';
import {
  createConstructionSimulation,
  startBuildingConstruction,
  startBuildingDemolition,
  startBuildingRelocation,
  type ConstructionSimulation,
} from '../world/construction';
import { IsometricWorldEngine, type RendererDebugInfo, type WorldEngineStats } from '../world/renderer';
import {
  HumanWakeGate,
  createResidentSimulation,
  type ResidentEntity,
  type ResidentSimulation,
} from '../world/residents';
import { harbourPlanFor } from '../world/harbour';
import { generateWorldTerrain, type GeneratedWorldMap } from '../world/terrain-engine';
import { registeredWorldPacks, worldPackFromParam } from './registry';

type PackKey = string;
type ScenarioKey = 'hornhoof' | 'stress150' | 'empty' | 'no_subscription' | 'live';
type LangKey = 'ru' | 'en';

const PACKS: Readonly<Record<PackKey, WorldPackManifest>> = Object.fromEntries(registeredWorldPacks().map(p => [p.id, p]));

const TEXT = {
  ru: {
    title: 'Живой мир (этапы 4-5)',
    scenarios: {
      hornhoof: 'Команда Hornhoof (944 задачи)',
      stress150: 'Стресс-тест (150 жителей)',
      empty: 'Новая компания (пустырь)',
      no_subscription: 'Шаблон без подписки',
      live: 'Сервер Hornhoof API',
    },
    modes: {
      active: 'Живой город',
      empty_lot: 'Пустырь без шаблона',
      no_subscription: 'Нет активной подписки (все отдыхают)',
    },
    kinds: {
      residence: 'Резиденция правителя',
      monument: 'Пирамида цели',
      department: 'Здание отдела',
      district_hub: 'Узел машины (район)',
      supply: 'Подписка (амбар / колодец)',
      house: 'Дом агента',
      statue: 'Статуя отдела',
      flophouse: 'Ночлежка разовых вызовов',
    },
    roleClasses: {
      executor: 'Исполнитель',
      checker: 'Проверяющий',
      head: 'Глава отдела',
      turnkey: 'Под ключ',
      day_laborer: 'Поденщик (разовый вызов)',
      ruler: 'Правитель (оркестратор)',
    } as Record<ResidentRoleClass, string>,
    liveStates: {
      working: 'Работает',
      idle: 'Без задачи (отдыхает у дома)',
      upgrading_home: 'Получил уровень (строит дом в лесах)',
      waiting_human: 'Ждет решения человека (у алтаря бога)',
      exhausted: 'Нет подписки (молится у пустого амбара)',
      turn_failed: 'Ход упал (сломан инструмент, дым над отделом)',
      machine_offline: 'Машина без связи (ночь в районе, спит)',
    } as Record<ResidentLiveState, string>,
    grid: 'Сетка стройки',
    relocateBtn: 'Перестроить по слову бога',
    relocateHint: 'Выберите свободную клетку на карте для переноса здания (ESC для отмены)',
    relocateCancelPick: 'Отменить выбор места',
    confirmTitle: 'Перестройка по слову бога',
    confirmQuestion: (label: string) => `Вы действительно хотите перестроить "${label}"?`,
    confirmAssignee: (who: string) => `Создастся маленькая задача для: ${who}. Место изменится только после принятия задачи.`,
    yes: 'Да',
    no: 'Нет',
    acceptTaskDemo: 'Принять задачу (done)',
    cancelTaskDemo: 'Отменить задачу (cancel)',
    pendingNotice: (num: number, c: number, r: number) =>
      `Ожидает принятия задачи #${num}. Здание стоит на старом месте; цель: (${c}, ${r}).`,
    agents: 'Агенты',
    residents: 'Жители',
    machines: 'Машины',
    subs: 'Подписки',
    tasks: 'Принято задач',
    topLv: 'Высший ур.',
    goals: 'Цели',
    statues: 'Статуи',
    wall: 'Стена',
    stage: 'Стадия',
    level: 'Уровень',
    outfit: 'Наряд',
    noLevelDayLaborer: 'Без уровня (поденщик)',
    acceptedTasks: 'Принято задач',
    toNextLevel: 'До след. уровня',
    maxLevel: 'Максимум',
    currentTask: 'Текущая задача',
    noCurrentTask: 'Нет активной задачи',
    department: 'Отдел',
    cityWide: 'Весь город',
    model: 'Модель подписки',
    machine: 'Машина',
    unassignedMachine: 'Не назначена',
    wakeBtn: 'Разбудить агента',
    wakeSent: (sec: number) => `Сигнал пробуждения отправлен (пауза ${sec} с)`,
    wakeCooldown: (sec: number) => `Слишком часто: подождите ${sec} с`,
    openAgentWindow: 'Открыть окно агента',
    inspectResidentBtn: 'Карточка жителя',
    fullness: 'Наполненность',
    progress: 'Прогресс',
    reached: 'Цель достигнута (праздник)',
    resting: 'Отдыхает (нет лимита)',
    footprint: 'Участок',
    coords: 'Клетка',
    close: 'Закрыть',
    readOnlyBadge: 'Только чтение Hornhoof',
    assigneeDept: 'главы отдела',
    assigneeAgent: 'самого агента',
    assigneeOrch: 'оркестратора',
  },
  en: {
    title: 'Live World (Stages 4-5)',
    scenarios: {
      hornhoof: 'Hornhoof Team (944 tasks)',
      stress150: 'Stress Test (150 residents)',
      empty: 'New Company (Empty Lot)',
      no_subscription: 'Template Without Subscription',
      live: 'Live Hornhoof API',
    },
    modes: {
      active: 'Active Live City',
      empty_lot: 'Empty Lot (No Template)',
      no_subscription: 'No Active Subscription (All Resting)',
    },
    kinds: {
      residence: 'Ruler Residence',
      monument: 'Goal Monument',
      department: 'Department Building',
      district_hub: 'Machine Hub (District)',
      supply: 'Subscription Supply',
      house: 'Agent House',
      statue: 'Department Statue',
      flophouse: 'One-Shot Call Lodge',
    },
    roleClasses: {
      executor: 'Executor',
      checker: 'Checker',
      head: 'Department Head',
      turnkey: 'Turnkey Generalist',
      day_laborer: 'Day-Laborer (One-Shot)',
      ruler: 'Ruler (Orchestrator)',
    } as Record<ResidentRoleClass, string>,
    liveStates: {
      working: 'Working',
      idle: 'Idle (resting near home)',
      upgrading_home: 'Leveled up (upgrading home in scaffolding)',
      waiting_human: "Waiting on human decision (at God's Altar)",
      exhausted: 'Out of subscription limit (praying at empty supply)',
      turn_failed: 'Turn failed (broken tool, smoke over department)',
      machine_offline: 'Machine offline (night district, sleeping)',
    } as Record<ResidentLiveState, string>,
    grid: 'Build Grid',
    relocateBtn: "Relocate by God's Word",
    relocateHint: 'Click a clear tile on the map to relocate this building (ESC to cancel)',
    relocateCancelPick: 'Cancel Tile Pick',
    confirmTitle: "Relocation by God's Word",
    confirmQuestion: (label: string) => `Do you really want to rebuild "${label}"?`,
    confirmAssignee: (who: string) => `Creates a small task for ${who}. Coordinates change only after the task is accepted.`,
    yes: 'Yes',
    no: 'No',
    acceptTaskDemo: 'Accept Task (done)',
    cancelTaskDemo: 'Cancel Task (cancel)',
    pendingNotice: (num: number, c: number, r: number) =>
      `Waiting on task #${num}. Building stays at old tile; destination: (${c}, ${r}).`,
    agents: 'Agents',
    residents: 'Residents',
    machines: 'Machines',
    subs: 'Plans',
    tasks: 'Accepted',
    topLv: 'Top Lv',
    goals: 'Goals',
    statues: 'Statues',
    wall: 'Wall',
    stage: 'Stage',
    level: 'Level',
    outfit: 'Outfit',
    noLevelDayLaborer: 'No level (day-laborer)',
    acceptedTasks: 'Accepted tasks',
    toNextLevel: 'To next level',
    maxLevel: 'Max',
    currentTask: 'Current task',
    noCurrentTask: 'No active task',
    department: 'Department',
    cityWide: 'City-wide',
    model: 'Subscription model',
    machine: 'Machine',
    unassignedMachine: 'Unassigned',
    wakeBtn: 'Wake agent',
    wakeSent: (sec: number) => `Wake signal sent (cooldown ${sec}s)`,
    wakeCooldown: (sec: number) => `Rate-limited: wait ${sec}s`,
    openAgentWindow: 'Open agent window',
    inspectResidentBtn: 'Inspect resident',
    fullness: 'Fullness',
    progress: 'Progress',
    reached: 'Goal reached (celebrating)',
    resting: 'Resting (no limit)',
    footprint: 'Footprint',
    coords: 'Tile',
    close: 'Close',
    readOnlyBadge: 'Read-Only Hornhoof',
    assigneeDept: 'department head',
    assigneeAgent: 'the agent',
    assigneeOrch: 'orchestrator',
  },
} as const;

type PendingModal = {
  building: CityBuilding;
  toCol: number;
  toRow: number;
};

type LiveWorldDebugHandle = {
  getStats: () => WorldEngineStats | null;
  getDebugInfo: () => RendererDebugInfo | null;
  getArtStats: () => WorldArtStats | null;
  getSummary: () => LiveCitySummary | null;
  getBuildings: () => readonly CityBuilding[];
  getResidents: () => readonly ResidentEntity[];
  getAltarTile: () => TileCoord | null;
  getSimFlags: () => {
    smokingDepartments: string[];
    stuckDepartments: string[];
    nightDistricts: string[];
    scaffoldingHouses: string[];
  } | null;
  setZoom: (zoom: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  centerOnBuilding: (buildingId: string, zoom?: number) => boolean;
  centerOnResident: (residentId: string, zoom?: number) => boolean;
  getResidentScreenPoint: (residentId: string) => { x: number; y: number } | null;
  selectResident: (residentId: string | null) => boolean;
  wakeResident: (agentId: string) => { allowed: boolean; remainingMs: number };
  setScenario: (scenario: ScenarioKey, pack?: PackKey) => void;
  triggerRelocationModal: (
    buildingId?: string,
  ) => { buildingId: string; fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
  /* Holds a building at stage n of the pack's whole construction line, building or torn down, so a check can look at that
     picture: the line runs over the pack's own stage count, whatever the building's own number of stages. */
  holdBuildingStage: (buildingId: string, stage: number, phase?: 'building' | 'demolishing') => boolean;
};

/* The slowest the construction timer runs: a held stage stays on screen for 20 seconds. */
const HELD_STAGES_PER_SEC = 0.05;

declare global {
  interface Window {
    __WORLD_LIVE__?: LiveWorldDebugHandle;
  }
}

function readParams(): { pack: PackKey; scenario: ScenarioKey; lang: LangKey; zoom: number; grid: boolean } {
  const sp = new URLSearchParams(window.location.search);
  const pack: PackKey = worldPackFromParam(sp.get('pack')).id;
  const rawMode = sp.get('mode');
  const scenario: ScenarioKey =
    rawMode === 'empty' || rawMode === 'no_subscription' || rawMode === 'live' || rawMode === 'stress150'
      ? rawMode
      : 'hornhoof';
  const lang: LangKey = sp.get('lang') === 'en' ? 'en' : 'ru';
  const zRaw = Number(sp.get('zoom') ?? '100');
  const zoom = Number.isFinite(zRaw) ? Math.max(0.5, Math.min(2.0, zRaw / 100)) : 1.0;
  const grid = sp.get('buildGrid') === '1';
  return { pack, scenario, lang, zoom, grid };
}

function fixtureFor(scenario: ScenarioKey): WorldLiveSnapshot {
  if (scenario === 'empty') return createEmptyCompanyFixture();
  if (scenario === 'no_subscription') return createNoSubscriptionFixture();
  if (scenario === 'stress150') return createStress150LiveFixture();
  return createHornhoofLiveFixture();
}

function Stage4LiveWorld() {
  const initial = useMemo(() => readParams(), []);
  const [packKey, setPackKey] = useState<PackKey>(initial.pack);
  const [scenario, setScenario] = useState<ScenarioKey>(initial.scenario);
  const [lang, setLang] = useState<LangKey>(initial.lang);
  const [buildGrid, setBuildGrid] = useState<boolean>(initial.grid);
  const [snapshot, setSnapshot] = useState<WorldLiveSnapshot>(() => fixtureFor(initial.scenario));
  const [apiNotice, setApiNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<WorldEngineStats | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [selectedResidentId, setSelectedResidentId] = useState<string | null>(null);
  const [wakeStatus, setWakeStatus] = useState<string | null>(null);
  const [residentsCount, setResidentsCount] = useState<number>(0);
  const [relocatingBuildingId, setRelocatingBuildingId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<PendingModal | null>(null);
  const [relocationSeq, setRelocationSeq] = useState<number>(945);

  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IsometricWorldEngine | null>(null);
  const mapRef = useRef<GeneratedWorldMap | null>(null);
  const cityRef = useRef<CityState | null>(null);
  const syncRef = useRef<LiveCitySyncResult | null>(null);
  const simRef = useRef<ResidentSimulation | null>(null);
  const constructionRef = useRef<ConstructionSimulation | null>(null);
  const wakeGateRef = useRef<HumanWakeGate>(new HumanWakeGate());
  const relocatingRef = useRef<string | null>(null);
  relocatingRef.current = relocatingBuildingId;

  const pack = PACKS[packKey];
  const t = TEXT[lang];

  /* Fetch live Hornhoof snapshot from /api/world/state when mode=live, or load built-in scenario fixture. */
  useEffect(() => {
    let active = true;
    setSelectedBuildingId(null);
    setSelectedResidentId(null);
    setWakeStatus(null);
    setRelocatingBuildingId(null);
    setConfirmModal(null);
    cityRef.current = null;

    if (scenario !== 'live') {
      setApiNotice(null);
      setSnapshot(fixtureFor(scenario));
      return;
    }

    void fetch('/api/world/state', { credentials: 'include' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as WorldLiveSnapshot;
      })
      .then(live => {
        if (active) {
          setApiNotice(null);
          setSnapshot(live);
        }
      })
      .catch(() => {
        if (active) {
          setApiNotice(
            lang === 'ru'
              ? 'Нет активной сессии API: показан снимок команды Hornhoof'
              : 'No active API session: showing Hornhoof team snapshot',
          );
          setSnapshot(createHornhoofLiveFixture());
        }
      });

    return () => {
      active = false;
    };
  }, [scenario, lang]);

  /* Generate terrain and mount PixiJS engine whenever pack or company seed changes. */
  const seed = snapshot.company.seed;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;

    const map = generateWorldTerrain(pack, { seed, mapSize: pack.mapSize });
    mapRef.current = map;
    cityRef.current = null;

    const synced = syncLiveSnapshotToCity(pack, map, snapshot, null);
    cityRef.current = synced.city;
    syncRef.current = synced;
    const sim = createResidentSimulation(pack, synced.city, snapshot, { harbour: harbourPlanFor(pack, map, synced.city) });
    simRef.current = sim;
    const constructionSim = createConstructionSimulation(pack);
    constructionRef.current = constructionSim;
    setResidentsCount(sim.residents.length);

    void IsometricWorldEngine.create({
      host,
      pack,
      terrainMap: map,
      showBuildGrid: buildGrid,
      initialZoom: initial.zoom,
      initialCenterTile: synced.city.center,
      onStats: next => {
        if (alive) setStats(next);
      },
      onHover: tile => {
        if (!alive) return;
        const eng = engineRef.current;
        const relId = relocatingRef.current;
        const curCity = cityRef.current;
        const curMap = mapRef.current;
        if (!eng || !relId || !curCity || !curMap || !tile) {
          eng?.setRelocationPreview(null);
          return;
        }
        const b = curCity.buildings.find(item => item.id === relId);
        if (!b) return;
        const valid = canRelocateBuildingTo(curCity, curMap, b.id, tile.col, tile.row);
        eng.setRelocationPreview({
          col: tile.col,
          row: tile.row,
          spanCol: b.spanCol,
          spanRow: b.spanRow,
          valid,
        });
      },
      onSelectResident: resident => {
        if (!alive) return;
        setWakeStatus(null);
        if (resident) {
          setSelectedResidentId(resident.id);
          setSelectedBuildingId(null);
        } else {
          setSelectedResidentId(null);
        }
      },
      onSelect: (pick: PickResult | null) => {
        if (!alive) return;
        const relId = relocatingRef.current;
        const curCity = cityRef.current;
        const curMap = mapRef.current;
        if (relId && curCity && curMap && pick) {
          const b = curCity.buildings.find(item => item.id === relId);
          if (b && canRelocateBuildingTo(curCity, curMap, b.id, pick.col, pick.row)) {
            setConfirmModal({ building: b, toCol: pick.col, toRow: pick.row });
          }
          return;
        }
        if (pick?.kind === 'object') {
          setSelectedBuildingId(pick.object.id);
          setSelectedResidentId(null);
        } else {
          setSelectedBuildingId(null);
        }
      },
    }).then(engine => {
      if (!alive) {
        engine.destroy();
        return;
      }
      engineRef.current = engine;
      /* A snapshot sync may have run while the engine loaded and replaced the city and the residents; the engine
         takes the newest from the refs, which both effects set before any engine resolves, so it moves the residents
         the page reads (#1983). */
      const latest = syncRef.current!;
      engine.setCityRenderState({
        city: latest.city,
        worldMode: latest.worldMode,
        emptyLotStakes: latest.emptyLotStakes,
        districtColors: latest.districtColors,
      });
      engine.setResidentSimulation(simRef.current!);
      engine.setConstructionSimulation(constructionRef.current!);
      engine.flushVisibleBakes();
      setStats(engine.getStats());

      window.__WORLD_LIVE__ = {
        getStats: () => engineRef.current?.getStats() ?? null,
        getDebugInfo: () => engineRef.current?.getRendererDebugInfo() ?? null,
        getArtStats: () => engineRef.current?.getArtStats() ?? null,
        getSummary: () => syncRef.current?.summary ?? null,
        getBuildings: () => cityRef.current?.buildings ?? [],
        getResidents: () => simRef.current?.residents ?? [],
        getAltarTile: () => simRef.current?.altarTile ?? null,
        getSimFlags: () =>
          simRef.current
            ? {
                smokingDepartments: [...simRef.current.smokingDepartmentIds],
                stuckDepartments: [...simRef.current.stuckDepartmentIds],
                nightDistricts: [...simRef.current.nightDistrictIds],
                scaffoldingHouses: [...simRef.current.scaffoldingHouseIds],
              }
            : null,
        setZoom: z => engineRef.current?.setZoom(z),
        panByScreen: (dx, dy) => engineRef.current?.panByScreen(dx, dy),
        flushVisibleBakes: () => engineRef.current?.flushVisibleBakes(),
        centerOnBuilding: (buildingId, zoom) => {
          const b = cityRef.current?.buildings.find(item => item.id === buildingId);
          if (!b || !engineRef.current) return false;
          engineRef.current.centerOnTile(
            { col: Math.floor(b.col + b.spanCol / 2), row: Math.floor(b.row + b.spanRow / 2) },
            zoom,
          );
          engineRef.current.flushVisibleBakes();
          return true;
        },
        centerOnResident: (residentId, zoom) => {
          if (!engineRef.current) return false;
          const ok = engineRef.current.centerOnResident(residentId, zoom);
          if (ok) engineRef.current.flushVisibleBakes();
          return ok;
        },
        getResidentScreenPoint: residentId => engineRef.current?.getResidentScreenPoint(residentId) ?? null,
        selectResident: residentId => {
          if (residentId === null) {
            setSelectedResidentId(null);
            engineRef.current?.setSelectedResidentId(null);
            return true;
          }
          const found = simRef.current?.residents.find(
            item => item.id === residentId || item.agentId === residentId,
          );
          if (!found) return false;
          setSelectedBuildingId(null);
          setSelectedResidentId(found.id);
          setWakeStatus(null);
          engineRef.current?.setSelectedResidentId(found.id);
          engineRef.current?.flushVisibleBakes();
          return true;
        },
        wakeResident: agentId => wakeGateRef.current.tryWake(agentId),
        setScenario: (nextScenario, nextPack) => {
          if (nextPack) setPackKey(nextPack);
          setScenario(nextScenario);
        },
        holdBuildingStage: (buildingId, stage, phase = 'building') => {
          const sim = constructionRef.current;
          const b = cityRef.current?.buildings.find(item => item.id === buildingId);
          if (!sim || !b) return false;
          const line = { ...b, maxStage: pack.stageCounts.construction };
          if (phase === 'demolishing') startBuildingDemolition(sim, { ...line, stage }, HELD_STAGES_PER_SEC);
          else startBuildingConstruction(sim, line, line.maxStage, stage, HELD_STAGES_PER_SEC);
          engineRef.current?.flushVisibleBakes();
          return true;
        },
        triggerRelocationModal: buildingId => {
          const curCity = cityRef.current;
          const curMap = mapRef.current;
          if (!curCity || !curMap) return null;
          const b =
            (buildingId ? curCity.buildings.find(item => item.id === buildingId) : null) ??
            curCity.buildings.find(item => item.kind === 'house') ??
            curCity.buildings[0];
          if (!b) return null;
          for (let dr = -16; dr <= 16; dr++) {
            for (let dc = -16; dc <= 16; dc++) {
              if (Math.hypot(dc, dr) < 4) continue;
              const c = b.col + dc;
              const r = b.row + dr;
              if (canRelocateBuildingTo(curCity, curMap, b.id, c, r)) {
                setSelectedResidentId(null);
                setSelectedBuildingId(b.id);
                setRelocatingBuildingId(b.id);
                setBuildGrid(true);
                engineRef.current?.setBuildGridVisible(true);
                engineRef.current?.setRelocationPreview({
                  col: c,
                  row: r,
                  spanCol: b.spanCol,
                  spanRow: b.spanRow,
                  valid: true,
                });
                setConfirmModal({ building: b, toCol: c, toRow: r });
                return { buildingId: b.id, fromCol: b.col, fromRow: b.row, toCol: c, toRow: r };
              }
            }
          }
          return null;
        },
      };
    });

    return () => {
      alive = false;
      delete window.__WORLD_LIVE__;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [pack, seed]);

  /* Re-sync live snapshot updates (relocations, stage changes, resident states) without remounting PixiJS. */
  const [syncResult, setSyncResult] = useState<LiveCitySyncResult | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const synced = syncLiveSnapshotToCity(pack, map, snapshot, cityRef.current);
    cityRef.current = synced.city;
    syncRef.current = synced;
    setSyncResult(synced);
    const sim = createResidentSimulation(pack, synced.city, snapshot, { harbour: harbourPlanFor(pack, map, synced.city) });
    simRef.current = sim;
    setResidentsCount(sim.residents.length);
    engineRef.current?.setCityRenderState({
      city: synced.city,
      worldMode: synced.worldMode,
      emptyLotStakes: synced.emptyLotStakes,
      districtColors: synced.districtColors,
    });
    engineRef.current?.setResidentSimulation(sim);
    if (!constructionRef.current || constructionRef.current.packId !== pack.id) {
      constructionRef.current = createConstructionSimulation(pack);
      engineRef.current?.setConstructionSimulation(constructionRef.current);
    } else {
      engineRef.current?.markCityDirty();
    }
  }, [pack, snapshot]);

  /* Toggle build grid cleanly on engine. */
  useEffect(() => {
    engineRef.current?.setBuildGridVisible(buildGrid);
  }, [buildGrid]);

  /* Disable resident picking while selecting a relocation tile so clicks land on tiles cleanly. */
  useEffect(() => {
    engineRef.current?.setResidentPickingEnabled(!relocatingBuildingId);
  }, [relocatingBuildingId]);

  /* Escape cancels relocation tile pick, modal, or selected card. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmModal(null);
        setRelocatingBuildingId(null);
        setSelectedResidentId(null);
        engineRef.current?.setSelectedResidentId(null);
        engineRef.current?.setRelocationPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedBuilding = useMemo(() => {
    if (!selectedBuildingId || !syncResult) return null;
    return syncResult.city.buildings.find(b => b.id === selectedBuildingId) ?? null;
  }, [selectedBuildingId, syncResult]);

  const selectedResident = useMemo(() => {
    if (!selectedResidentId || !simRef.current) return null;
    return simRef.current.residents.find(r => r.id === selectedResidentId) ?? null;
  }, [selectedResidentId, residentsCount, snapshot]);

  const handleHumanWake = useCallback(
    async (resident: ResidentEntity) => {
      const check = wakeGateRef.current.tryWake(resident.agentId);
      if (!check.allowed) {
        const sec = Math.max(1, Math.ceil(check.remainingMs / 1000));
        setWakeStatus(t.wakeCooldown(sec));
        return;
      }
      if (scenario === 'live' && !apiNotice && resident.roleClass !== 'day_laborer') {
        try {
          await fetch(`/api/agents/${encodeURIComponent(resident.agentId)}/messages`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'World map wake ping' }),
          });
        } catch {
          /* Non-blocking in offline preview. */
        }
      }
      setWakeStatus(t.wakeSent(60));
    },
    [scenario, apiNotice, t],
  );

  const assigneeLabelFor = useCallback(
    (b: CityBuilding) => {
      if (b.kind === 'department' || b.kind === 'statue') return t.assigneeDept;
      if (b.kind === 'house') return `${t.assigneeAgent} (${b.label})`;
      return t.assigneeOrch;
    },
    [t],
  );

  const handleConfirmYes = useCallback(async () => {
    if (!confirmModal) return;
    const { building, toCol, toRow } = confirmModal;

    if (scenario === 'live' && !apiNotice) {
      const res = await fetch('/api/world/relocations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          buildingId: building.id,
          buildingKind: building.kind,
          buildingLabel: building.label,
          fromCol: building.col,
          fromRow: building.row,
          toCol,
          toRow,
          departmentId: building.departmentId ?? null,
          agentId: building.kind === 'house' ? (building.entityId ?? null) : null,
          confirmed: true,
        }),
      });
      if (res.ok) {
        const nextLive = (await (await fetch('/api/world/state', { credentials: 'include' })).json()) as WorldLiveSnapshot;
        setSnapshot(nextLive);
      }
    } else {
      /* Standalone preview creates the exact same pending relocation task record (moves ONLY on task done!). */
      const taskNumber = relocationSeq;
      setRelocationSeq(n => n + 1);
      const nextRel: WorldRelocationRecord = {
        id: `rel-${taskNumber}`,
        buildingId: building.id,
        buildingKind: building.kind,
        buildingLabel: building.label,
        fromCol: building.col,
        fromRow: building.row,
        toCol,
        toRow,
        taskId: `task-${taskNumber}`,
        taskNumber,
        taskStatus: 'open',
        assigneeAgentId: building.entityId ?? 'orchestrator',
        departmentId: building.departmentId ?? null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      setSnapshot(prev => ({
        ...prev,
        relocations: [...prev.relocations, nextRel],
      }));
    }

    setConfirmModal(null);
    setRelocatingBuildingId(null);
    engineRef.current?.setRelocationPreview(null);
  }, [confirmModal, scenario, apiNotice, relocationSeq]);

  const handleResolveDemoRelocation = useCallback((relocationId: string, outcome: 'applied' | 'cancelled') => {
    if (outcome === 'applied' && constructionRef.current && cityRef.current) {
      const targetRel = snapshot.relocations.find(r => r.id === relocationId);
      const oldBuilding = targetRel
        ? cityRef.current.buildings.find(b => b.id === targetRel.buildingId)
        : undefined;
      if (targetRel && oldBuilding) {
        startBuildingRelocation(
          constructionRef.current,
          oldBuilding,
          targetRel.toCol,
          targetRel.toRow,
          1.8,
        );
      }
    }
    setSnapshot(prev => ({
      ...prev,
      relocations: prev.relocations.map(r =>
        r.id === relocationId
          ? {
              ...r,
              taskStatus: outcome === 'applied' ? 'done' : 'cancelled',
              status: outcome,
              resolvedAt: new Date().toISOString(),
            }
          : r,
      ),
    }));
  }, [snapshot.relocations]);

  const summary = syncResult?.summary ?? null;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: pack.palette.backdrop }}>
      <div ref={hostRef} data-testid="world-stage4-canvas" style={{ position: 'absolute', inset: 0 }} />

      {/* Top compact toolbar */}
      <div
        data-testid="world-stage4-topbar"
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
          border: '1px solid rgba(226, 200, 146, 0.28)',
          color: '#F3EAD7',
          fontSize: 13,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ color: '#F3D28A', fontSize: 14 }}>{t.title}</strong>
          <span
            data-testid="world-stage4-mode"
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background:
                snapshot.company.worldMode === 'active'
                  ? 'rgba(78, 178, 114, 0.22)'
                  : snapshot.company.worldMode === 'no_subscription'
                    ? 'rgba(224, 128, 72, 0.25)'
                    : 'rgba(130, 165, 224, 0.24)',
              border: '1px solid rgba(255, 255, 255, 0.16)',
              fontSize: 12,
            }}
          >
            {t.modes[snapshot.company.worldMode]}
          </span>
          <span style={{ fontSize: 11, opacity: 0.78 }}>{t.readOnlyBadge}</span>
          {apiNotice && <span style={{ fontSize: 11, color: '#F5C470' }}>{apiNotice}</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select
            aria-label="Scenario"
            data-testid="world-stage4-scenario-select"
            value={scenario}
            onChange={e => setScenario(e.target.value as ScenarioKey)}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
            }}
          >
            <option value="hornhoof">{t.scenarios.hornhoof}</option>
            <option value="stress150">{t.scenarios.stress150}</option>
            <option value="empty">{t.scenarios.empty}</option>
            <option value="no_subscription">{t.scenarios.no_subscription}</option>
            <option value="live">{t.scenarios.live}</option>
          </select>

          <select
            aria-label="World Pack"
            data-testid="world-stage4-pack-select"
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
                {p.name[lang]}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setBuildGrid(g => !g)}
            style={{
              background: buildGrid ? '#3F6E54' : '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 9px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t.grid}
          </button>

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

      {/* Relocating banner */}
      {relocatingBuildingId && (
        <div
          data-testid="world-stage4-relocate-banner"
          style={{
            position: 'fixed',
            top: 64,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 10,
            background: 'rgba(30, 46, 36, 0.94)',
            border: '1px solid rgba(114, 224, 152, 0.55)',
            color: '#E7F9EE',
            fontSize: 13,
            zIndex: 12,
          }}
        >
          <span>{t.relocateHint}</span>
          <button
            type="button"
            onClick={() => {
              setRelocatingBuildingId(null);
              engineRef.current?.setRelocationPreview(null);
            }}
            style={{
              background: 'rgba(255,255,255,0.12)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '3px 8px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {t.relocateCancelPick}
          </button>
        </div>
      )}

      {/* Bottom-left live telemetry HUD */}
      {summary && (
        <div
          data-testid="world-stage4-summary"
          style={{
            position: 'fixed',
            bottom: 12,
            left: 12,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 10,
            background: 'rgba(18, 16, 13, 0.86)',
            border: '1px solid rgba(226, 200, 146, 0.25)',
            color: '#E8DEC8',
            fontSize: 12,
            zIndex: 10,
          }}
        >
          <span><strong>{summary.companyName}</strong></span>
          <span>{t.agents}: <strong>{summary.agentsCount}</strong> ({t.topLv} {summary.topAgentLevel})</span>
          <span data-testid="world-stage5-residents-count">{t.residents}: <strong>{residentsCount}</strong></span>
          <span>{t.machines}: <strong>{summary.machinesCount}</strong></span>
          <span>{t.subs}: <strong>{summary.activeSubscriptionsCount}/{summary.subscriptionsCount}</strong></span>
          <span>{t.tasks}: <strong>{summary.acceptedTasksTotal}</strong></span>
          <span>{t.goals}: <strong>{summary.reachedGoalsCount}/{summary.goalsCount}</strong></span>
          <span>{t.statues}: <strong>{summary.statuesCount}</strong></span>
          <span>{t.wall}: <strong>{summary.wallTilesCount}</strong></span>
          {stats && (
            <span data-testid="world-stage4-fps">
              {stats.fps} FPS ({stats.rendererKind})
            </span>
          )}
        </div>
      )}

      {/* Stage 5 Resident Agent Card */}
      {selectedResident && (
        <div
          data-testid="world-stage5-agent-card"
          style={{
            position: 'fixed',
            top: 68,
            right: 12,
            width: 320,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'rgba(18, 16, 13, 0.94)',
            border: '1px solid rgba(243, 210, 138, 0.48)',
            color: '#F3EAD7',
            fontSize: 13,
            display: 'grid',
            gap: 8,
            zIndex: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span
                  aria-label="Provider cloak color"
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    background: selectedResident.cloakColor,
                    border: '1px solid rgba(255,255,255,0.45)',
                    display: 'inline-block',
                  }}
                />
                <strong data-testid="world-stage5-agent-name" style={{ fontSize: 15, color: '#F3D28A' }}>
                  {selectedResident.name}
                </strong>
              </div>
              <div style={{ fontSize: 12, color: '#C7BBA2', marginTop: 2 }}>
                {selectedResident.look.label[lang]} ({t.roleClasses[selectedResident.roleClass]})
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedResidentId(null);
                setWakeStatus(null);
                engineRef.current?.setSelectedResidentId(null);
              }}
              style={{
                background: 'transparent',
                color: '#C7BAA0',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {t.close}
            </button>
          </div>

          <div
            data-testid="world-stage5-agent-state"
            style={{
              padding: '5px 8px',
              borderRadius: 8,
              background:
                selectedResident.liveState === 'working'
                  ? 'rgba(72, 168, 108, 0.2)'
                  : selectedResident.liveState === 'turn_failed'
                    ? 'rgba(218, 92, 64, 0.24)'
                    : selectedResident.liveState === 'waiting_human'
                      ? 'rgba(235, 190, 74, 0.22)'
                      : 'rgba(116, 152, 214, 0.2)',
              border: '1px solid rgba(255,255,255,0.14)',
              fontSize: 12,
            }}
          >
            {t.liveStates[selectedResident.liveState]}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12 }}>
            <div data-testid="world-stage5-agent-level">
              {t.level}:{' '}
              <strong>
                {selectedResident.level === null
                  ? t.noLevelDayLaborer
                  : `${lang === 'ru' ? 'ур.' : 'Lv'} ${selectedResident.level} (${t.outfit} ${selectedResident.outfitTier}/5)`}
              </strong>
            </div>
            <div data-testid="world-stage5-agent-accepted">
              {t.acceptedTasks}: <strong>{selectedResident.acceptedTasks}</strong>
            </div>
            <div data-testid="world-stage5-agent-next-level">
              {t.toNextLevel}:{' '}
              <strong>
                {selectedResident.level === null
                  ? '-'
                  : selectedResident.nextLevelRemaining === 0
                    ? t.maxLevel
                    : selectedResident.nextLevelRemaining}
              </strong>
            </div>
            <div data-testid="world-stage5-agent-department">
              {t.department}: <strong>{selectedResident.departmentName ?? t.cityWide}</strong>
            </div>
          </div>

          <div data-testid="world-stage5-agent-task" style={{ fontSize: 12, color: '#E8DEC8' }}>
            {t.currentTask}:{' '}
            <strong>
              {selectedResident.currentTask
                ? `#${selectedResident.currentTask.number} ${selectedResident.currentTask.title}`
                : t.noCurrentTask}
            </strong>
          </div>

          <div style={{ display: 'grid', gap: 4, fontSize: 12, color: '#D7CCB4' }}>
            <div data-testid="world-stage5-agent-model">
              {t.model}:{' '}
              <strong>
                {selectedResident.model} ({selectedResident.provider ?? 'api'})
              </strong>
            </div>
            <div data-testid="world-stage5-agent-machine">
              {t.machine}: <strong>{selectedResident.machineHostname ?? t.unassignedMachine}</strong>
            </div>
          </div>

          {wakeStatus && (
            <div
              data-testid="world-stage5-wake-status"
              style={{
                padding: '6px 8px',
                borderRadius: 7,
                background: 'rgba(243, 210, 138, 0.14)',
                border: '1px solid rgba(243, 210, 138, 0.34)',
                fontSize: 12,
                color: '#F7E09E',
              }}
            >
              {wakeStatus}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            {selectedResident.roleClass !== 'day_laborer' && (
              <button
                type="button"
                data-testid="world-stage5-wake-btn"
                onClick={() => void handleHumanWake(selectedResident)}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(243, 210, 138, 0.45)',
                  background: 'rgba(210, 162, 74, 0.24)',
                  color: '#F7DF9E',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {t.wakeBtn}
              </button>
            )}
            <a
              data-testid="world-stage5-open-agent"
              href={`/agents/${encodeURIComponent(selectedResident.agentId)}`}
              target="_blank"
              rel="noreferrer"
              style={{
                flex: 1,
                padding: '8px 10px',
                borderRadius: 8,
                border: 'none',
                background: '#D9A648',
                color: '#1A140B',
                fontWeight: 700,
                textAlign: 'center',
                textDecoration: 'none',
                fontSize: 12,
              }}
            >
              {t.openAgentWindow}
            </a>
          </div>
        </div>
      )}

      {/* Right-side selected building card */}
      {selectedBuilding && !selectedResident && (
        <div
          data-testid="world-stage4-inspector"
          style={{
            position: 'fixed',
            top: 68,
            right: 12,
            width: 300,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'rgba(18, 16, 13, 0.92)',
            border: '1px solid rgba(226, 200, 146, 0.36)',
            color: '#F3EAD7',
            fontSize: 13,
            display: 'grid',
            gap: 8,
            zIndex: 15,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 15, color: '#F3D28A' }}>{selectedBuilding.label}</strong>
            <button
              type="button"
              onClick={() => setSelectedBuildingId(null)}
              style={{
                background: 'transparent',
                color: '#C7BAA0',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {t.close}
            </button>
          </div>
          <div style={{ fontSize: 12, color: '#BFB399' }}>{t.kinds[selectedBuilding.kind]}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12 }}>
            <div>{t.stage}: <strong>{selectedBuilding.stage}/{selectedBuilding.maxStage}</strong></div>
            <div>{t.footprint}: <strong>{selectedBuilding.spanCol}x{selectedBuilding.spanRow}</strong></div>
            <div>{t.coords}: <strong>({selectedBuilding.col}, {selectedBuilding.row})</strong></div>
            {selectedBuilding.kind === 'house' && (
              <div>{t.level}: <strong>{lang === 'ru' ? 'ур.' : 'Lv'} {selectedBuilding.level}</strong></div>
            )}
            {selectedBuilding.acceptedTasks !== undefined && (
              <div>{t.tasks}: <strong>{selectedBuilding.acceptedTasks}</strong></div>
            )}
            {selectedBuilding.fullness !== undefined && (
              <div>{t.fullness}: <strong>{Math.round(selectedBuilding.fullness * 100)}%</strong></div>
            )}
            {selectedBuilding.progress !== undefined && (
              <div>{t.progress}: <strong>{Math.round(selectedBuilding.progress * 100)}%</strong></div>
            )}
          </div>
          {selectedBuilding.reached && (
            <div style={{ fontSize: 12, color: '#FFE07A' }}>{t.reached}</div>
          )}
          {selectedBuilding.resting && (
            <div style={{ fontSize: 12, color: '#9FC1EA' }}>{t.resting}</div>
          )}

          {selectedBuilding.kind === 'house' && selectedBuilding.entityId && (
            <button
              type="button"
              onClick={() => {
                const resident = simRef.current?.residents.find(r => r.agentId === selectedBuilding.entityId);
                if (resident) {
                  setSelectedBuildingId(null);
                  setSelectedResidentId(resident.id);
                  engineRef.current?.setSelectedResidentId(resident.id);
                  engineRef.current?.centerOnResident(resident.id);
                }
              }}
              style={{
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid rgba(154, 198, 240, 0.4)',
                background: 'rgba(84, 134, 186, 0.24)',
                color: '#D7ECFF',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {t.inspectResidentBtn}
            </button>
          )}

          {selectedBuilding.pendingRelocation ? (
            <div
              data-testid="world-stage4-pending-relocation"
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(255, 209, 102, 0.14)',
                border: '1px solid rgba(255, 209, 102, 0.4)',
                display: 'grid',
                gap: 6,
                fontSize: 12,
              }}
            >
              <div>
                {t.pendingNotice(
                  selectedBuilding.pendingRelocation.taskNumber,
                  selectedBuilding.pendingRelocation.toCol,
                  selectedBuilding.pendingRelocation.toRow,
                )}
              </div>
              {scenario !== 'live' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    data-testid="world-stage4-accept-relocation"
                    onClick={() => handleResolveDemoRelocation(selectedBuilding.pendingRelocation!.relocationId, 'applied')}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: '#3F8E5A',
                      color: '#fff',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {t.acceptTaskDemo}
                  </button>
                  <button
                    type="button"
                    data-testid="world-stage4-cancel-relocation"
                    onClick={() => handleResolveDemoRelocation(selectedBuilding.pendingRelocation!.relocationId, 'cancelled')}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: '#8E4343',
                      color: '#fff',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {t.cancelTaskDemo}
                  </button>
                </div>
              )}
            </div>
          ) : (
            snapshot.company.worldMode !== 'empty_lot' && (
              <button
                type="button"
                data-testid="world-stage4-relocate-btn"
                onClick={() => {
                  setRelocatingBuildingId(selectedBuilding.id);
                  setBuildGrid(true);
                }}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(243, 210, 138, 0.45)',
                  background: 'rgba(210, 162, 74, 0.24)',
                  color: '#F7DF9E',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {t.relocateBtn}
              </button>
            )
          )}
        </div>
      )}

      {/* God's Word relocation confirmation modal ("Вы действительно хотите...? Да / Нет") */}
      {confirmModal && (
        <div
          data-testid="world-stage4-confirm-modal"
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(8, 7, 5, 0.62)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 40,
          }}
        >
          <div
            style={{
              width: 390,
              maxWidth: '92vw',
              padding: '20px 22px',
              borderRadius: 14,
              background: '#1E1A14',
              border: '1px solid rgba(243, 210, 138, 0.5)',
              color: '#F6EEDD',
              display: 'grid',
              gap: 12,
              boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
            }}
          >
            <div style={{ fontSize: 13, color: '#E0BA68', fontWeight: 700 }}>{t.confirmTitle}</div>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>
              {t.confirmQuestion(confirmModal.building.label)}
            </div>
            <div style={{ fontSize: 13, color: '#CBC0A8', lineHeight: 1.45 }}>
              {t.confirmAssignee(assigneeLabelFor(confirmModal.building))}
            </div>
            <div style={{ fontSize: 12, color: '#A99C84' }}>
              ({confirmModal.building.col}, {confirmModal.building.row}) -&gt; ({confirmModal.toCol}, {confirmModal.toRow})
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                data-testid="world-stage4-confirm-no"
                onClick={() => {
                  setConfirmModal(null);
                  setRelocatingBuildingId(null);
                  engineRef.current?.setRelocationPreview(null);
                }}
                style={{
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: '#2C261F',
                  color: '#E8DEC8',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t.no}
              </button>
              <button
                type="button"
                data-testid="world-stage4-confirm-yes"
                onClick={() => void handleConfirmYes()}
                style={{
                  padding: '8px 20px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#D9A648',
                  color: '#1A140B',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {t.yes}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Stage4LiveWorld />);
}
