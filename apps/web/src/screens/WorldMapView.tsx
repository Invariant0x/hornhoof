/* Pack-agnostic live isometric world map embedded directly inside Hornhoof's MapScreen.
   Keeps every product chrome control (ZoomBar bottom-left, Orchestrator ticker bottom-center,
   MapVersion bottom-right) in the exact same DOM structure and coordinates as the standard map,
   while replacing the schematic canvas with the active world pack's interactive isometric city,
   all 6 entity side cards, and on-map Department Mode. Contains zero theme-specific words. */

import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import { useStream } from '../live';
import type { Department, Me, Org } from '../types';
import { AgentState } from '../ui/AgentState';
import { Bar, percent } from '../ui/Bar';
import { ZoomBar } from '../ui/canvas';
import { takeEscape } from '../ui/escape';
import { MapVersion } from '../ui/VersionMark';
import { worldArtFiles } from '../world/art-files';
import type { CityBuilding, CityState } from '../world/city-layout';
import { createConstructionSimulation, type ConstructionSimulation } from '../world/construction';
import { buildDepartmentFocus, isLinkStrictlyOnRoads, type DepartmentFocusSpec } from '../world/department-focus';
import {
  canRelocateBuildingTo,
  syncLiveSnapshotToCity,
  type LiveCitySyncResult,
} from '../world/live-sync';
import type { WorldPackManifest } from '../world/manifest';
import { snapshotFromOrg } from '../world/org-fallback';
import { IsometricWorldEngine, type WorldEngineStats } from '../world/renderer';
import {
  HumanWakeGate,
  createResidentSimulation,
  type ResidentEntity,
  type ResidentSimulation,
} from '../world/residents';
import { harbourPlanFor } from '../world/harbour';
import { generateWorldTerrain, type GeneratedWorldMap } from '../world/terrain-engine';
import { useShellTop } from '../ui/shellBars';
import { orchestratorStatus, useMapRoom } from './Map';
import { clock } from './Subscriptions';
import { WorldLoadingScreen, type WorldLoadProgress } from './WorldLoadingScreen';
import { WorldSideCards, type WorldSelection } from './WorldSideCards';

export type WorldMapViewProps = Readonly<{
  me: Me;
  org: Org;
  pack: WorldPackManifest;
  inside?: boolean;
  windowOpen: boolean;
  activeDepartmentId?: string | null;
  onOpenOrchestrator: () => void;
  onOpenAgent: (agentId: string) => void;
  onCloseDepartment?: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenGoal?: (goalId: string) => void;
  onOpenTracker?: (departmentId: string) => void;
  onOpenTab?: (tab: 'subscriptions' | 'machines') => void;
  onHire?: (dept: Department) => void;
  /* Hidden behind another tab: the world stays mounted and paused, and comes back as it was (#1947 item 3). */
  parked?: boolean;
}>;

type PendingRelocateModal = Readonly<{
  building: CityBuilding;
  toCol: number;
  toRow: number;
}>;

type ProductWorldDebugHandle = Readonly<{
  getPackId: () => string;
  getStats: () => WorldEngineStats | null;
  getBuildings: () => readonly CityBuilding[];
  getResidents: () => readonly ResidentEntity[];
  getDepartmentFocus: () => {
    departmentId: string;
    bannerColor: string;
    highlightedBuildings: number;
    highlightedResidents: number;
    linksCount: number;
    linkKinds: string[];
    allLinksOnRoads: boolean;
    pathTilesTotal: number;
  } | null;
  selectBuildingByKind: (kind: CityBuilding['kind'], index?: number) => { id: string; label: string; kind: string } | null;
  selectResidentByRoleClass: (roleClass?: string) => { id: string; agentId: string; name: string } | null;
  clearSelection: () => void;
  centerOnBuilding: (buildingId: string, zoom?: number) => boolean;
  fitToCity: () => void;
  flushVisibleBakes: () => void;
}>;

declare global {
  interface Window {
    __WORLD_PRODUCT__?: ProductWorldDebugHandle;
  }
}

/* How long one frame may bake ground behind the loading screen, so its progress keeps moving. */
const BAKE_SLICE_MS = 12;

const orchestratorWorks = (o: NonNullable<Org['orchestrator']>, limitAt: string | null) =>
  !!o.planned && !limitAt && !o.alarm && !!o.program && o.program.state !== 'gone';

export function WorldMapView({
  me,
  org,
  pack,
  inside = false,
  parked = false,
  windowOpen,
  activeDepartmentId = null,
  onOpenOrchestrator,
  onOpenAgent,
  onCloseDepartment,
  onOpenTask,
  onOpenGoal,
  onOpenTracker,
  onOpenTab,
  onHire,
}: WorldMapViewProps) {
  const t = useT();
  const wc = t.skins.worldCard;
  const { language } = useLanguage();
  const company = me.person.scopeKind === 'company';

  const fallbackSnapshot = useMemo(() => snapshotFromOrg(org), [org]);
  const [serverSnapshot, setServerSnapshot] = useState<WorldLiveSnapshot | null>(null);
  const snapshot = serverSnapshot ?? fallbackSnapshot;

  const [zoom, setZoom] = useState<number>(1.0);
  const [selection, setSelection] = useState<WorldSelection | null>(null);
  const [wakeStatus, setWakeStatus] = useState<string | null>(null);
  const [relocatingBuilding, setRelocatingBuilding] = useState<CityBuilding | null>(null);
  const [confirmRelocate, setConfirmRelocate] = useState<PendingRelocateModal | null>(null);
  const [relocateBusy, setRelocateBusy] = useState(false);
  const [residentsTick, setResidentsTick] = useState(0);
  /* The loading screen, shown only while the pictures kept in the browser are missing or out of date (#1947). */
  const [loading, setLoading] = useState<WorldLoadProgress | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const roomStyle = useMapRoom(boxRef, `${windowOpen}`, useShellTop());
  const engineRef = useRef<IsometricWorldEngine | null>(null);
  /* Parked behind another tab: the engine draws nothing until the map is shown again (#1947 item 3). */
  const parkedRef = useRef(parked);
  parkedRef.current = parked;
  useEffect(() => {
    engineRef.current?.setPaused(parked);
  }, [parked]);
  const mapRef = useRef<GeneratedWorldMap | null>(null);
  const cityRef = useRef<CityState | null>(null);
  const syncRef = useRef<LiveCitySyncResult | null>(null);
  const simRef = useRef<ResidentSimulation | null>(null);
  const constructionRef = useRef<ConstructionSimulation | null>(null);
  const snapshotRef = useRef<WorldLiveSnapshot>(snapshot);
  snapshotRef.current = snapshot;
  const relocatingRef = useRef<CityBuilding | null>(null);
  relocatingRef.current = relocatingBuilding;
  const onOpenAgentRef = useRef(onOpenAgent);
  onOpenAgentRef.current = onOpenAgent;
  const onOpenOrchestratorRef = useRef(onOpenOrchestrator);
  onOpenOrchestratorRef.current = onOpenOrchestrator;
  const wakeGateRef = useRef<HumanWakeGate>(new HumanWakeGate());

  /* Load authoritative read-only world snapshot from /api/world/state and keep it fresh via SSE. */
  const fetchWorldState = useCallback(() => {
    void api
      .get<WorldLiveSnapshot>('/api/world/state')
      .then(data => {
        if (data && data.company && Array.isArray(data.departments)) {
          setServerSnapshot(data);
        }
      })
      .catch(() => {
        /* Falls back cleanly to snapshotFromOrg(org) in offline or minimal mock setups. */
      });
  }, []);

  useEffect(() => {
    fetchWorldState();
  }, [fetchWorldState, org.company.id, org.departments.length, org.agents.total, org.agents.working]);

  useStream(msg => {
    if (msg.type === 'org' || msg.type === 'company_theme') {
      fetchWorldState();
    }
  });

  /* Map any clicked building cleanly to its entity side card or Department Mode. */
  const selectBuilding = useCallback(
    (building: CityBuilding) => {
      setWakeStatus(null);
      if (building.kind === 'department' && building.departmentId) {
        setSelection({ kind: 'department', departmentId: building.departmentId, building });
        return;
      }
      if (building.kind === 'house') {
        const agentId = building.entityId ?? building.residentIds[0];
        if (agentId) {
          setSelection({ kind: 'agent', agentId, building });
          return;
        }
      }
      if (building.kind === 'supply') {
        setSelection({ kind: 'subscription', subscriptionId: building.entityId ?? building.id, building });
        return;
      }
      if (building.kind === 'district_hub') {
        setSelection({ kind: 'machine', machineId: building.entityId ?? building.districtId ?? building.id, building });
        return;
      }
      if (building.kind === 'monument') {
        setSelection({ kind: 'goal', goalId: building.entityId ?? building.id, building });
        return;
      }
      if (building.kind === 'statue' && building.departmentId) {
        setSelection({ kind: 'statue', departmentId: building.departmentId, building });
        return;
      }
      if (building.kind === 'residence') {
        setSelection({ kind: 'orchestrator', building });
        return;
      }
      if (building.kind === 'flophouse') {
        const firstDept = snapshotRef.current.departments[0];
        if (firstDept) {
          setSelection({ kind: 'department', departmentId: firstDept.id, building });
        }
      }
    },
    [],
  );

  const selectResident = useCallback((resident: ResidentEntity) => {
    setWakeStatus(null);
    engineRef.current?.setSelectedResidentId(resident.id);
    if (resident.roleClass === 'ruler') {
      setSelection(null);
      onOpenOrchestratorRef.current();
      return;
    }
    if (resident.roleClass === 'day_laborer') {
      setSelection({ kind: 'agent', agentId: resident.agentId, resident });
      return;
    }
    setSelection(null);
    onOpenAgentRef.current(resident.agentId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setWakeStatus(null);
    setRelocatingBuilding(null);
    setConfirmRelocate(null);
    engineRef.current?.setSelectedResidentId(null);
    engineRef.current?.setRelocationPreview(null);
    engineRef.current?.setBuildGridVisible(false);
    if (activeDepartmentId) onCloseDepartment?.();
  }, [activeDepartmentId, onCloseDepartment]);

  /* The engine's handlers call the current choices through refs, so a new callback from the shell (any re-render, such
     as a tab switch) never remounts the world (#1947 item 3). */
  const picks = useRef({ clearSelection, selectBuilding, selectResident });
  picks.current = { clearSelection, selectBuilding, selectResident };

  /* Sync external /departments/:id route directly into on-map Department Mode (no separate department screen). */
  useEffect(() => {
    if (!activeDepartmentId) return;
    const deptBuilding = cityRef.current?.buildings.find(
      b => b.kind === 'department' && b.departmentId === activeDepartmentId,
    );
    setSelection({ kind: 'department', departmentId: activeDepartmentId, building: deptBuilding });
  }, [activeDepartmentId]);

  /* Mount PixiJS / Canvas2D IsometricWorldEngine once per pack + seed. */
  const seed = snapshot.company.seed || org.company.id;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let bakeFrame = 0;
    /* Whether this mount shows the loading screen: only when some picture has to be downloaded first. */
    let screened = false;

    /* Counts the visible ground pieces as they bake, a slice per frame, then lets the map show. */
    const bakeBehindScreen = (engine: IsometricWorldEngine) => {
      const step = () => {
        if (!alive) return;
        const { done, total } = engine.bakeVisibleStep(BAKE_SLICE_MS);
        if (done < total) {
          setLoading(l => l && { ...l, step: 'bake', bakedChunks: done, totalChunks: total });
          bakeFrame = requestAnimationFrame(step);
          return;
        }
        engine.flushVisibleBakes();
        setLoading(null);
      };
      setLoading(l => l && { ...l, step: 'bake' });
      bakeFrame = requestAnimationFrame(step);
    };

    const mountWorld = () => {
      const map = generateWorldTerrain(pack, { seed, mapSize: pack.mapSize });
      mapRef.current = map;

      const synced = syncLiveSnapshotToCity(pack, map, snapshotRef.current);
      cityRef.current = synced.city;
      syncRef.current = synced;

      const sim = createResidentSimulation(pack, synced.city, snapshotRef.current, { harbour: harbourPlanFor(pack, map, synced.city) });
      simRef.current = sim;
      setResidentsTick(n => n + 1);

      const constructionSim = createConstructionSimulation(pack);
      constructionRef.current = constructionSim;

      void IsometricWorldEngine.create({
        /* The product map lowers its quality by the frame time it measures (#1947 item 6). */
        quality: 'auto',
        host,
        pack,
        terrainMap: map,
        showBuildGrid: false,
        initialZoom: 1.0,
        initialCenterTile: synced.city.center,
        onStats: next => {
          setZoom(prev => (Math.abs(prev - next.zoom) > 0.004 ? next.zoom : prev));
        },
        onHover: tile => {
          const rel = relocatingRef.current;
          const curCity = cityRef.current;
          const curMap = mapRef.current;
          if (!rel || !curCity || !curMap || !tile) {
            engineRef.current?.setRelocationPreview(null);
            return;
          }
          const valid = canRelocateBuildingTo(curCity, curMap, rel.id, tile.col, tile.row);
          engineRef.current?.setRelocationPreview({
            col: tile.col,
            row: tile.row,
            spanCol: rel.spanCol,
            spanRow: rel.spanRow,
            valid,
          });
        },
        onSelectResident: resident => {
          if (relocatingRef.current) return;
          if (resident) picks.current.selectResident(resident);
        },
        onSelect: pick => {
          const rel = relocatingRef.current;
          const curCity = cityRef.current;
          const curMap = mapRef.current;
          if (rel && curCity && curMap && pick) {
            if (canRelocateBuildingTo(curCity, curMap, rel.id, pick.col, pick.row)) {
              setConfirmRelocate({ building: rel, toCol: pick.col, toRow: pick.row });
            }
            return;
          }
          if (pick?.kind === 'object' && curCity) {
            const building = curCity.buildings.find(b => b.id === pick.object.id);
            if (building) {
              picks.current.selectBuilding(building);
              return;
            }
          }
          picks.current.clearSelection();
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
        engine.setResidentSimulation(sim);
        engine.setConstructionSimulation(constructionSim);
        engine.setPaused(parkedRef.current);
        if (screened) bakeBehindScreen(engine);
        else engine.flushVisibleBakes();
        setZoom(engine.getStats().zoom);

        window.__WORLD_PRODUCT__ = {
          getPackId: () => pack.id,
          getStats: () => engineRef.current?.getStats() ?? null,
          getBuildings: () => cityRef.current?.buildings ?? [],
          getResidents: () => simRef.current?.residents ?? [],
          getDepartmentFocus: () => {
            const f = engineRef.current?.getDepartmentFocus();
            const city = cityRef.current;
            if (!f) return null;
            return {
              departmentId: f.departmentId,
              bannerColor: f.bannerColor,
              highlightedBuildings: f.highlightedBuildingIds.size,
              highlightedResidents: f.highlightedResidentIds.size,
              linksCount: f.links.length,
              linkKinds: [...new Set(f.links.map(l => l.kind))],
              allLinksOnRoads: Boolean(city) && f.links.every(l => isLinkStrictlyOnRoads(city!, l)),
              pathTilesTotal: f.links.reduce((acc, l) => acc + l.path.length, 0),
            };
          },
          selectBuildingByKind: (kind, index = 0) => {
            const matches = (cityRef.current?.buildings ?? []).filter(b => b.kind === kind);
            const target = matches[index];
            if (!target) return null;
            const targetZoom = kind === 'department' ? 0.78 : 1.15;
            engineRef.current?.centerOnBuilding(target.id, targetZoom);
            engineRef.current?.flushVisibleBakes();
            picks.current.selectBuilding(target);
            return { id: target.id, label: target.label, kind: target.kind };
          },
          selectResidentByRoleClass: roleClass => {
            const list = simRef.current?.residents ?? [];
            const found = (roleClass ? list.find(r => r.roleClass === roleClass) : list[0]) ?? list[0];
            if (!found) return null;
            engineRef.current?.centerOnResident(found.id, 1.4);
            engineRef.current?.setSelectedResidentId(found.id);
            engineRef.current?.flushVisibleBakes();
            picks.current.selectResident(found);
            return { id: found.id, agentId: found.agentId, name: found.name };
          },
          clearSelection: () => picks.current.clearSelection(),
          centerOnBuilding: (buildingId, nextZoom) => {
            const ok = engineRef.current?.centerOnBuilding(buildingId, nextZoom) ?? false;
            if (ok) engineRef.current?.flushVisibleBakes();
            return ok;
          },
          fitToCity: () => {
            engineRef.current?.fitToCity();
            engineRef.current?.flushVisibleBakes();
          },
          flushVisibleBakes: () => engineRef.current?.flushVisibleBakes(),
        };
      });
    };

    void (async () => {
      const files = worldArtFiles(pack);
      const missing = files ? await files.missing() : null;
      if (!alive) return;
      if (files && missing && missing.paths.length > 0) {
        screened = true;
        setLoading({ step: 'art', loadedBytes: 0, totalBytes: missing.bytes, bakedChunks: 0, totalChunks: 0 });
        await files.fill(p => {
          if (alive) setLoading(l => l && { ...l, loadedBytes: p.loadedBytes, totalBytes: p.totalBytes });
        });
        if (!alive) return;
        setLoading(l => l && { ...l, step: 'map' });
        /* Lets the screen paint its map step before laying out the city takes the main thread. */
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (!alive) return;
      } else {
        /* Drops the kept copies the index no longer lists. */
        void files?.fill();
      }
      mountWorld();
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(bakeFrame);
      setLoading(null);
      delete window.__WORLD_PRODUCT__;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [pack, seed]);

  /* Re-sync live snapshot changes cleanly into the running city without remounting PixiJS. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const synced = syncLiveSnapshotToCity(pack, map, snapshot, cityRef.current);
    cityRef.current = synced.city;
    syncRef.current = synced;
    const sim = createResidentSimulation(pack, synced.city, snapshot, { harbour: harbourPlanFor(pack, map, synced.city) });
    simRef.current = sim;
    setResidentsTick(n => n + 1);
    const constructionSim = createConstructionSimulation(pack);
    constructionRef.current = constructionSim;
    engineRef.current?.setCityRenderState({
      city: synced.city,
      worldMode: synced.worldMode,
      emptyLotStakes: synced.emptyLotStakes,
      districtColors: synced.districtColors,
    });
    engineRef.current?.setResidentSimulation(sim);
    engineRef.current?.setConstructionSimulation(constructionSim);
  }, [pack, snapshot]);

  /* Compute and apply Department Mode overlay on the live city map whenever a department is selected. */
  const departmentFocus = useMemo<DepartmentFocusSpec | null>(() => {
    if (selection?.kind !== 'department' || !cityRef.current) return null;
    const idx = snapshot.departments.findIndex(d => d.id === selection.departmentId);
    return buildDepartmentFocus(cityRef.current, simRef.current?.residents ?? [], selection.departmentId, {
      departmentIndex: idx >= 0 ? idx : 0,
    });
  }, [selection, snapshot.departments, residentsTick]);

  useEffect(() => {
    engineRef.current?.setDepartmentFocus(departmentFocus);
    engineRef.current?.flushVisibleBakes();
  }, [departmentFocus]);

  /* Escape cancels relocation mode or closes the active side card & Department Mode. */
  useEffect(() => {
    if (parked || (!selection && !relocatingBuilding && !confirmRelocate)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      if (confirmRelocate) {
        setConfirmRelocate(null);
      } else if (relocatingBuilding) {
        setRelocatingBuilding(null);
        engineRef.current?.setBuildGridVisible(false);
        engineRef.current?.setRelocationPreview(null);
      } else {
        clearSelection();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [parked, selection, relocatingBuilding, confirmRelocate, clearSelection]);

  const canRelocateBuilding = useCallback(
    (building: CityBuilding): boolean => {
      if (snapshot.permissions.canRelocateAny) return true;
      if (building.departmentId && snapshot.permissions.relocatableDepartmentIds.includes(building.departmentId)) {
        return true;
      }
      return false;
    },
    [snapshot.permissions],
  );

  const handleWakeAgent = useCallback(
    (agentId: string) => {
      const check = wakeGateRef.current.tryWake(agentId);
      if (!check.allowed) {
        const sec = Math.max(1, Math.ceil(check.remainingMs / 1000));
        setWakeStatus(wc.wakeCooldown(sec));
        return;
      }
      setWakeStatus(wc.wakeSent(60));
      void api.post(`/api/agents/${encodeURIComponent(agentId)}/messages`, { text: 'World map wake ping' }).catch(() => {});
    },
    [wc],
  );

  const handleConfirmRelocate = useCallback(async () => {
    if (!confirmRelocate || relocateBusy) return;
    setRelocateBusy(true);
    try {
      await api.post('/api/world/relocations', {
        buildingId: confirmRelocate.building.id,
        buildingKind: confirmRelocate.building.kind,
        buildingLabel: confirmRelocate.building.label,
        fromCol: confirmRelocate.building.col,
        fromRow: confirmRelocate.building.row,
        toCol: confirmRelocate.toCol,
        toRow: confirmRelocate.toRow,
        departmentId: confirmRelocate.building.departmentId ?? null,
        agentId: confirmRelocate.building.kind === 'house' ? (confirmRelocate.building.entityId ?? null) : null,
        confirmed: true,
      });
      fetchWorldState();
    } catch {
      /* Ignore relocation errors in read-only mock environments. */
    } finally {
      setRelocateBusy(false);
      setConfirmRelocate(null);
      setRelocatingBuilding(null);
      engineRef.current?.setBuildGridVisible(false);
      engineRef.current?.setRelocationPreview(null);
    }
  }, [confirmRelocate, relocateBusy, fetchWorldState]);

  const sub = org.orchestrator?.subscription ?? null;
  const limitUntil = org.orchestrator?.limitUntil ?? null;
  const limitAt = limitUntil && Date.parse(limitUntil) > Date.now() ? clock(language, limitUntil) : null;
  const status = orchestratorStatus(t, sub, limitAt, org.orchestrator?.planned);

  return (
    <div className="map world-map" ref={boxRef} data-world-canvas={pack.id} hidden={parked} inert={inside || parked} aria-hidden={inside || parked || undefined}>
      <div className="world-canvas-host" ref={hostRef} />
      {loading && <WorldLoadingScreen progress={loading} />}
      <div className="map-room" style={roomStyle}>
        <MapVersion off={inside} />
      </div>

      {relocatingBuilding && (
        <div className="world-relocate-banner glass" role="status" onPointerDown={e => e.stopPropagation()}>
          <span>{wc.relocateHint}</span>
          <button
            className="btn small ghost"
            type="button"
            onClick={() => {
              setRelocatingBuilding(null);
              engineRef.current?.setBuildGridVisible(false);
              engineRef.current?.setRelocationPreview(null);
            }}
          >
            {wc.relocateCancel}
          </button>
        </div>
      )}

      <ZoomBar
        k={zoom}
        onZoom={factor => engineRef.current?.zoomBy(factor)}
        onFit={() => engineRef.current?.fitToCity()}
      />

      {!windowOpen && (
        <div
          className={`ticker glass${company ? ' world-ticker-btn' : ''}`}
          aria-live="polite"
          role={company ? 'button' : undefined}
          tabIndex={company ? 0 : undefined}
          onPointerDown={e => e.stopPropagation()}
          onClick={company ? onOpenOrchestrator : undefined}
          onKeyDown={
            company
              ? e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenOrchestrator();
                  }
                }
              : undefined
          }
        >
          <span className={`live${org.orchestrator && orchestratorWorks(org.orchestrator, limitAt) ? '' : ' off'}`} />
          <span className="tt">{t.map.orchestrator}</span>
          <AgentState agent={org.orchestrator} serverNow={org.serverNow} />
          <span className="tx" title={status}>{status}</span>
          {org.orchestrator?.effort && (
            <span className="te">
              {t.agent.effortLine(t.agent.efforts[org.orchestrator.effort] ?? org.orchestrator.effort)}
            </span>
          )}
          {org.orchestrator?.context != null && (
            <span className="tc" title={t.dept.contextUsed(percent(org.orchestrator.context))}>
              {t.dept.context}
              <Bar used={org.orchestrator.context} />
              {percent(org.orchestrator.context)}%
            </span>
          )}
        </div>
      )}

      <WorldSideCards
        me={me}
        org={org}
        snapshot={snapshot}
        selection={selection}
        departmentFocus={departmentFocus}
        residents={simRef.current?.residents ?? []}
        wakeStatus={wakeStatus}
        canRelocateBuilding={canRelocateBuilding}
        onClose={clearSelection}
        onSelectAgent={agentId => {
          setWakeStatus(null);
          const res = simRef.current?.residents.find(r => r.agentId === agentId);
          if (res) {
            engineRef.current?.centerOnResident(res.id, 1.35);
            engineRef.current?.setSelectedResidentId(res.id);
          }
          setSelection(null);
          onOpenAgentRef.current(agentId);
        }}
        onSelectDepartment={deptId => {
          setWakeStatus(null);
          const deptBld = cityRef.current?.buildings.find(b => b.kind === 'department' && b.departmentId === deptId);
          if (deptBld) engineRef.current?.centerOnBuilding(deptBld.id, 0.78);
          setSelection({ kind: 'department', departmentId: deptId, building: deptBld });
        }}
        onWakeAgent={handleWakeAgent}
        onStartRelocate={building => {
          setRelocatingBuilding(building);
          engineRef.current?.setBuildGridVisible(true);
        }}
        onOpenAgent={onOpenAgent}
        onOpenOrchestrator={onOpenOrchestrator}
        onOpenTask={onOpenTask}
        onOpenGoal={onOpenGoal}
        onOpenTracker={onOpenTracker}
        onOpenTab={onOpenTab}
        onHire={onHire}
      />

      {confirmRelocate && (
        <div className="dialog-back" onPointerDown={e => e.target === e.currentTarget && !relocateBusy && setConfirmRelocate(null)}>
          <div className="dialog world-confirm-dialog" role="dialog" aria-modal="true" aria-label={wc.relocateTitle}>
            <header>
              <h2>{wc.relocateTitle}</h2>
            </header>
            <div className="world-confirm-body">
              <p>{wc.relocateAsk(confirmRelocate.building.label)}</p>
              <p className="muted">{wc.relocateNote}</p>
              <div className="settings-actions">
                <button className="btn small ghost" type="button" disabled={relocateBusy} onClick={() => setConfirmRelocate(null)}>
                  {wc.no}
                </button>
                <button className="btn small" type="button" disabled={relocateBusy} onClick={() => void handleConfirmRelocate()}>
                  {wc.yes}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
