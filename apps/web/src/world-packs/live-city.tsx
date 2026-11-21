/* Stage 4 live data isometric world viewer with bilingual RU/EN UI, live Hornhoof API + built-in
   team/empty-lot/no-subscription scenarios, pack switching (Egypt / Dungeon) and full
   God's Word relocation confirmation workflow ("Вы действительно хотите перестроить ...? Да / Нет"). */

import type { WorldLiveSnapshot, WorldRelocationRecord } from '@hornhoof/protocol/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CityBuilding, CityState } from '../world/city-layout';
import type { PickResult } from '../world/coords';
import {
  canRelocateBuildingTo,
  createEmptyCompanyFixture,
  createHornhoofLiveFixture,
  createNoSubscriptionFixture,
  syncLiveSnapshotToCity,
  type LiveCitySummary,
  type LiveCitySyncResult,
} from '../world/live-sync';
import type { WorldPackManifest } from '../world/manifest';
import { IsometricWorldEngine, type RendererDebugInfo, type WorldEngineStats } from '../world/renderer';
import { generateWorldTerrain, type GeneratedWorldMap } from '../world/terrain-engine';
import { DUNGEON_WORLD_PACK } from './dungeon/pack';
import { EGYPT_WORLD_PACK } from './egypt/pack';

type PackKey = 'egypt' | 'dungeon';
type ScenarioKey = 'hornhoof' | 'empty' | 'no_subscription' | 'live';
type LangKey = 'ru' | 'en';

const PACKS: Record<PackKey, WorldPackManifest> = {
  egypt: EGYPT_WORLD_PACK,
  dungeon: DUNGEON_WORLD_PACK,
};

const TEXT = {
  ru: {
    title: 'Этап 4. Живой мир',
    scenarios: {
      hornhoof: 'Команда Hornhoof (944 задачи)',
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
    machines: 'Машины',
    subs: 'Подписки',
    tasks: 'Принято задач',
    topLv: 'Макс. ур.',
    goals: 'Цели',
    statues: 'Статуи',
    wall: 'Стена',
    stage: 'Стадия',
    level: 'Уровень',
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
    title: 'Stage 4. Live World',
    scenarios: {
      hornhoof: 'Hornhoof Team (944 tasks)',
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
    machines: 'Machines',
    subs: 'Plans',
    tasks: 'Accepted',
    topLv: 'Top Lv',
    goals: 'Goals',
    statues: 'Statues',
    wall: 'Wall',
    stage: 'Stage',
    level: 'Level',
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
  getSummary: () => LiveCitySummary | null;
  getBuildings: () => readonly CityBuilding[];
  setZoom: (zoom: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  centerOnBuilding: (buildingId: string, zoom?: number) => boolean;
  setScenario: (scenario: ScenarioKey, pack?: PackKey) => void;
  triggerRelocationModal: (buildingId?: string) => { buildingId: string; fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
};

declare global {
  interface Window {
    __WORLD_LIVE__?: LiveWorldDebugHandle;
  }
}

function readParams(): { pack: PackKey; scenario: ScenarioKey; lang: LangKey; zoom: number; grid: boolean } {
  const sp = new URLSearchParams(window.location.search);
  const pack: PackKey = sp.get('pack') === 'dungeon' ? 'dungeon' : 'egypt';
  const rawMode = sp.get('mode');
  const scenario: ScenarioKey =
    rawMode === 'empty' || rawMode === 'no_subscription' || rawMode === 'live' ? rawMode : 'hornhoof';
  const lang: LangKey = sp.get('lang') === 'en' ? 'en' : 'ru';
  const zRaw = Number(sp.get('zoom') ?? '100');
  const zoom = Number.isFinite(zRaw) ? Math.max(0.5, Math.min(2.0, zRaw / 100)) : 1.0;
  const grid = sp.get('buildGrid') === '1';
  return { pack, scenario, lang, zoom, grid };
}

function fixtureFor(scenario: ScenarioKey): WorldLiveSnapshot {
  if (scenario === 'empty') return createEmptyCompanyFixture();
  if (scenario === 'no_subscription') return createNoSubscriptionFixture();
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
  const [relocatingBuildingId, setRelocatingBuildingId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<PendingModal | null>(null);
  const [relocationSeq, setRelocationSeq] = useState<number>(945);

  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IsometricWorldEngine | null>(null);
  const mapRef = useRef<GeneratedWorldMap | null>(null);
  const cityRef = useRef<CityState | null>(null);
  const syncRef = useRef<LiveCitySyncResult | null>(null);
  const relocatingRef = useRef<string | null>(null);
  relocatingRef.current = relocatingBuildingId;

  const pack = PACKS[packKey];
  const t = TEXT[lang];

  /* Fetch live Hornhoof snapshot from /api/world/state when mode=live, or load built-in scenario fixture. */
  useEffect(() => {
    let active = true;
    setSelectedBuildingId(null);
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
      engine.setCityRenderState({
        city: synced.city,
        worldMode: synced.worldMode,
        emptyLotStakes: synced.emptyLotStakes,
        districtColors: synced.districtColors,
      });
      engine.flushVisibleBakes();
      setStats(engine.getStats());

      window.__WORLD_LIVE__ = {
        getStats: () => engineRef.current?.getStats() ?? null,
        getDebugInfo: () => engineRef.current?.getRendererDebugInfo() ?? null,
        getSummary: () => syncRef.current?.summary ?? null,
        getBuildings: () => cityRef.current?.buildings ?? [],
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
        setScenario: (nextScenario, nextPack) => {
          if (nextPack) setPackKey(nextPack);
          setScenario(nextScenario);
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

  /* Re-sync live snapshot updates (relocations, stage changes) onto the existing city without remounting PixiJS. */
  const [syncResult, setSyncResult] = useState<LiveCitySyncResult | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const synced = syncLiveSnapshotToCity(pack, map, snapshot, cityRef.current);
    cityRef.current = synced.city;
    syncRef.current = synced;
    setSyncResult(synced);
    engineRef.current?.setCityRenderState({
      city: synced.city,
      worldMode: synced.worldMode,
      emptyLotStakes: synced.emptyLotStakes,
      districtColors: synced.districtColors,
    });
  }, [pack, snapshot]);

  /* Toggle build grid cleanly on engine. */
  useEffect(() => {
    engineRef.current?.setBuildGridVisible(buildGrid);
  }, [buildGrid]);

  /* Escape cancels relocation tile pick or modal. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmModal(null);
        setRelocatingBuildingId(null);
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
  }, []);

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
          background: 'rgba(18, 16, 13, 0.84)',
          border: '1px solid rgba(226, 200, 146, 0.28)',
          color: '#F3EAD7',
          backdropFilter: 'blur(8px)',
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
            <option value="empty">{t.scenarios.empty}</option>
            <option value="no_subscription">{t.scenarios.no_subscription}</option>
            <option value="live">{t.scenarios.live}</option>
          </select>

          <select
            aria-label="World Pack"
            data-testid="world-stage4-pack-select"
            value={packKey}
            onChange={e => setPackKey(e.target.value as PackKey)}
            style={{
              background: '#24201A',
              color: '#F3EAD7',
              border: '1px solid rgba(226, 200, 146, 0.34)',
              borderRadius: 8,
              padding: '4px 8px',
              fontSize: 12,
            }}
          >
            <option value="egypt">{EGYPT_WORLD_PACK.name[lang]}</option>
            <option value="dungeon">{DUNGEON_WORLD_PACK.name[lang]}</option>
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
            background: 'rgba(18, 16, 13, 0.84)',
            border: '1px solid rgba(226, 200, 146, 0.25)',
            color: '#E8DEC8',
            fontSize: 12,
            zIndex: 10,
          }}
        >
          <span><strong>{summary.companyName}</strong></span>
          <span>{t.agents}: <strong>{summary.agentsCount}</strong> ({t.topLv} {summary.topAgentLevel})</span>
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

      {/* Right-side selected building card */}
      {selectedBuilding && (
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
              <div>{t.level}: <strong>Lv {selectedBuilding.level}</strong></div>
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
