import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HUMAN_WAKE_COOLDOWN_MS } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import {
  createHornhoofLiveFixture,
  createStress150LiveFixture,
  syncLiveSnapshotToCity,
} from '../src/world/live-sync';
import { resolvePackRoleLook } from '../src/world/manifest';
import {
  HumanWakeGate,
  createResidentSimulation,
  stepResidentSimulation,
} from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { DUNGEON_WORLD_PACK } from '../src/world-packs/dungeon/pack';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

describe('Stage 5 residents, role behaviors, 7 live states, wake cooldown and 150-resident performance', () => {
  it('enforces class behaviors: head never carries stones (pure animation poke), executor carries stones to goal/statue, checker inspects and returns stone on rework', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

    const heads = sim.residents.filter(r => r.roleClass === 'head');
    const builders = sim.residents.filter(r => r.roleClass === 'executor' && r.archetype === 'builder' && r.liveState === 'working');
    const checkers = sim.residents.filter(r => r.roleClass === 'checker' && r.liveState === 'working');

    expect(heads.length).toBeGreaterThanOrEqual(4);
    expect(builders.length).toBeGreaterThanOrEqual(4);
    expect(checkers.length).toBeGreaterThanOrEqual(2);

    let sawHeadDirecting = false;
    let sawBuilderCarryingToGoal = false;
    let sawBuilderCarryingToStatue = false;
    let sawCheckerInspecting = false;
    let sawCheckerReturningStone = false;

    for (let tick = 0; tick < 240; tick++) {
      stepResidentSimulation(sim, 0.25);
      for (const h of heads) {
        expect(h.carrying, `head ${h.name} must never carry stones`).toBe('none');
        expect(h.look.insignia).toBe(true);
        if (h.pose === 'directing') sawHeadDirecting = true;
      }
      for (const b of builders) {
        if (b.carrying === 'stone') {
          if (b.deliveryTargetKind === 'monument') sawBuilderCarryingToGoal = true;
          if (b.deliveryTargetKind === 'statue') sawBuilderCarryingToStatue = true;
        }
      }
      for (const c of checkers) {
        expect(c.carrying === 'stone', `checker ${c.name} does not haul construction stones`).toBe(false);
        if (c.pose === 'inspecting') sawCheckerInspecting = true;
        if (c.carrying === 'returned_stone' && c.pose === 'returning_stone') {
          sawCheckerReturningStone = true;
        }
      }
    }

    expect(sawHeadDirecting).toBe(true);
    expect(sawBuilderCarryingToGoal).toBe(true);
    expect(sawBuilderCarryingToStatue).toBe(true);
    expect(sawCheckerInspecting).toBe(true);
    expect(sawCheckerReturningStone).toBe(true);
  });

  it('handles turnkey generalists (own house + visits any department), day-laborers (no house, no level, flophouse), and ruler (visits target or lies exhausted)', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

    const turnkey = sim.residents.find(r => r.roleClass === 'turnkey');
    expect(turnkey).toBeDefined();
    expect(turnkey!.houseId).not.toBeNull();
    expect(turnkey!.visitedDepartmentIds.length).toBeGreaterThanOrEqual(2);

    const dayLaborers = sim.residents.filter(r => r.roleClass === 'day_laborer');
    expect(dayLaborers.length).toBeGreaterThanOrEqual(1);
    for (const dl of dayLaborers) {
      expect(dl.houseId).toBeNull();
      expect(dl.level).toBeNull();
      expect(dl.homeBuildingId).toBe('flophouse-main');
    }

    /* Ruler visits talkingToAgentId when healthy. */
    const ruler = sim.residents.find(r => r.roleClass === 'ruler')!;
    expect(ruler).toBeDefined();
    expect(ruler.carrying).toBe('none');
    expect(ruler.talkingToAgentId).not.toBeNull();

    for (let i = 0; i < 60; i++) stepResidentSimulation(sim, 0.25);

    /* When ruler's own subscription is exhausted, ruler lies exhausted and prays too! */
    const exhaustedRulerLive = {
      ...live,
      orchestrator: live.orchestrator
        ? { ...live.orchestrator, resting: true, liveState: 'exhausted' as const }
        : null,
    };
    const simExhaustedRuler = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, exhaustedRulerLive);
    stepResidentSimulation(simExhaustedRuler, 0.5);
    const rEx = simExhaustedRuler.residents.find(r => r.roleClass === 'ruler')!;
    expect(rEx.liveState).toBe('exhausted');
    expect(rEx.pose).toBe('praying');
  });

  it('renders all 7 live states (working, idle, upgrading_home, waiting_human at pack altar, exhausted, turn_failed + smoke, machine_offline night + sleep) and role archetypes', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

    for (let i = 0; i < 80; i++) stepResidentSimulation(sim, 0.25);

    const statesSeen = new Set(sim.residents.map(r => r.liveState));
    expect(statesSeen.has('working')).toBe(true);
    expect(statesSeen.has('idle')).toBe(true);
    expect(statesSeen.has('upgrading_home')).toBe(true);
    expect(statesSeen.has('waiting_human')).toBe(true);
    expect(statesSeen.has('exhausted')).toBe(true);
    expect(statesSeen.has('turn_failed')).toBe(true);
    expect(statesSeen.has('machine_offline')).toBe(true);

    /* Waiting-for-human agent stands at God's Altar derived from pack.altarAnchor. */
    expect(sim.altarTile).not.toBeNull();
    const waiter = sim.residents.find(r => r.liveState === 'waiting_human')!;
    expect(waiter.pose).toBe('holding_scroll');
    expect(Math.hypot(waiter.col - sim.altarTile.col, waiter.row - sim.altarTile.row)).toBeLessThanOrEqual(4);

    /* Upgrading home adds scaffolding to that resident's house. */
    const upgrader = sim.residents.find(r => r.liveState === 'upgrading_home')!;
    expect(upgrader.pose).toBe('building_home');
    expect(sim.scaffoldingHouseIds.has(upgrader.houseId!)).toBe(true);

    /* Failed turn produces broken_tool pose + smoke over their department building. */
    const failed = sim.residents.find(r => r.liveState === 'turn_failed')!;
    expect(failed.pose).toBe('broken_tool');
    expect(sim.smokingDepartmentIds.size).toBeGreaterThanOrEqual(1);

    /* Offline machine creates nighttime district + sleeping residents. */
    expect(sim.nightDistrictIds.size).toBeGreaterThanOrEqual(1);
    const sleeper = sim.residents.find(r => r.liveState === 'machine_offline')!;
    expect(sleeper.pose).toBe('sleeping');

    /* Special role archetypes active on the map: OPS-FIX firefighter & OPS-WATCH patrol gong & DEV-SEC gate guard. */
    const firefighter = sim.residents.find(r => r.archetype === 'firefighter');
    const patrol = sim.residents.find(r => r.archetype === 'patrol');
    const gateGuard = sim.residents.find(r => r.archetype === 'gate_guard');
    expect(firefighter).toBeDefined();
    expect(patrol).toBeDefined();
    expect(gateGuard).toBeDefined();
    expect(firefighter!.look.prop).toBe('water_jar');
    expect(patrol!.look.prop).toBe('gong');
    expect(gateGuard!.look.prop).toBe('spear_shield');

    /* Role look fallback: Dungeon lacks a custom 'scribe' look -> cleanly falls back to classFallbackLooks.executor. */
    const dungeonFallback = resolvePackRoleLook(DUNGEON_WORLD_PACK, 'MKT-WRITE', 'executor', 'scribe');
    expect(dungeonFallback.id).toBe(DUNGEON_WORLD_PACK.classFallbackLooks!.executor.id);
  });

  it('rate-limits human agent wake calls cleanly and simulates 150 residents with zero theme words in core modules', () => {
    const gate = new HumanWakeGate(HUMAN_WAKE_COOLDOWN_MS);
    const t0 = 1_000_000;
    expect(gate.tryWake('agent-1', t0)).toEqual({ allowed: true, remainingMs: 0 });
    const blocked = gate.tryWake('agent-1', t0 + 15_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remainingMs).toBe(HUMAN_WAKE_COOLDOWN_MS - 15_000);
    /* Independent per agent. */
    expect(gate.tryWake('agent-2', t0 + 15_000).allowed).toBe(true);
    /* Allowed again after cooldown expires. */
    expect(gate.tryWake('agent-1', t0 + HUMAN_WAKE_COOLDOWN_MS + 1).allowed).toBe(true);

    /* 150-resident live simulation stress test. */
    const stressLive = createStress150LiveFixture();
    expect(stressLive.agents).toHaveLength(150);
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: stressLive.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, stressLive);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, stressLive);
    expect(sim.residents.length).toBeGreaterThanOrEqual(150);

    const start = performance.now();
    for (let tick = 0; tick < 200; tick++) {
      stepResidentSimulation(sim, 0.05);
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(250);
    for (const r of sim.residents) {
      expect(Number.isFinite(r.col) && Number.isFinite(r.row)).toBe(true);
    }

    /* Modularity contract: zero theme-specific words in resident core modules. */
    const forbidden = /\b(egypt|pharaoh|nile|pyramidion|oasis|dungeon|magma|bedrock|papyrus|medjay)\b/i;
    const resSrc = readFileSync(resolve(process.cwd(), 'src/world/residents.ts'), 'utf8');
    const renSrc = readFileSync(resolve(process.cwd(), 'src/world/residents-renderer.ts'), 'utf8');
    expect(forbidden.test(resSrc)).toBe(false);
    expect(forbidden.test(renSrc)).toBe(false);
  });

  it('drives resident walkPhase strictly from distance traveled rather than elapsed time so feet never slide', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 100 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

    const walker = sim.residents.find(r => r.liveState === 'working' && r.path.length >= 2)!;
    expect(walker).toBeDefined();
    walker.actionTimer = 0;
    /* Advance past the starting tile if already seated on waypoint 0. */
    stepResidentSimulation(sim, 0.05);
    const phaseStart = walker.walkPhase;
    const colStart = walker.col;
    const rowStart = walker.row;

    stepResidentSimulation(sim, 0.12);
    const moved = Math.hypot(walker.col - colStart, walker.row - rowStart);
    expect(moved).toBeGreaterThan(0.05);
    const phaseDeltaMoving = walker.walkPhase - phaseStart;
    expect(phaseDeltaMoving).toBeGreaterThan(0);

    /* While standing still performing an action, walkPhase must not drift forward. */
    walker.actionTimer = 2.0;
    const phaseStationary = walker.walkPhase;
    stepResidentSimulation(sim, 0.2);
    expect(walker.walkPhase).toBeCloseTo(phaseStationary, 6);
  });

  /* #1983: masons carry blocks to the site and lay them there; on the way home they carry nothing. */
  it('lays the stone at the work site, not at home, and leaves home with the next one', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
    const builders = sim.residents.filter(r => r.archetype === 'builder' && r.liveState === 'working');
    expect(builders.length).toBeGreaterThanOrEqual(4);
    const near = (r: (typeof builders)[number], t: { col: number; row: number }) => Math.hypot(r.col - t.col, r.row - t.row);
    let laidAtSite = 0;
    let waitedAtHome = 0;
    /* Only the pauses at the end of a walk count; a resident may start mid-route with a pause of its own. */
    const walked = new Set<string>();
    for (let tick = 0; tick < 1600; tick++) {
      stepResidentSimulation(sim, 0.1);
      for (const b of builders) {
        if (b.actionTimer <= 0) walked.add(b.id);
        if (b.actionTimer <= 0 || !walked.has(b.id)) continue;
        const atSite = near(b, b.workTile) < near(b, b.homeTile);
        if (atSite) {
          expect(b.pose, `${b.name} at the site`).toBe('building');
          expect(b.carrying, `${b.name} lays the stone it brought`).toBe('none');
          laidAtSite++;
        } else {
          expect(b.pose, `${b.name} at home`).toBe('carrying_stone');
          expect(b.carrying).toBe('stone');
          waitedAtHome++;
        }
      }
    }
    expect(laidAtSite).toBeGreaterThan(0);
    expect(waitedAtHome).toBeGreaterThan(0);
  });
});
