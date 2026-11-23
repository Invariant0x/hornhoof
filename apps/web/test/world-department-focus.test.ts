import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDepartmentFocus, departmentBannerColor, isLinkStrictlyOnRoads } from '../src/world/department-focus';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation } from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

describe('Stage 8 pack-agnostic Department Mode overlay', () => {
  it('highlights department buildings and residents gently and routes links strictly along city roads', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 100 });
    const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);

    const devDept = live.departments.find(d => d.roleCode === 'DEV') ?? live.departments[0]!;
    const focus = buildDepartmentFocus(synced.city, sim.residents, devDept.id, {
      departmentIndex: 0,
    });

    expect(focus.departmentId).toBe(devDept.id);
    expect(focus.bannerColor).toBe(departmentBannerColor(devDept.id, 0));

    /* Department building + its statues + houses of agents in this department are highlighted. */
    const deptBuilding = synced.city.buildings.find(b => b.kind === 'department' && b.departmentId === devDept.id)!;
    expect(focus.highlightedBuildingIds.has(deptBuilding.id)).toBe(true);

    const deptHouses = synced.city.buildings.filter(b => b.kind === 'house' && b.departmentId === devDept.id);
    expect(deptHouses.length).toBeGreaterThan(0);
    for (const h of deptHouses) {
      expect(focus.highlightedBuildingIds.has(h.id)).toBe(true);
    }

    const otherDeptBuilding = synced.city.buildings.find(b => b.kind === 'department' && b.departmentId !== devDept.id);
    if (otherDeptBuilding) {
      expect(focus.highlightedBuildingIds.has(otherDeptBuilding.id)).toBe(false);
    }

    /* Residents of the department are highlighted gently; residents of other departments are not. */
    const deptResidents = sim.residents.filter(r => r.departmentId === devDept.id);
    expect(deptResidents.length).toBeGreaterThan(0);
    for (const r of deptResidents) {
      expect(focus.highlightedResidentIds.has(r.id)).toBe(true);
    }
    const otherResident = sim.residents.find(r => r.departmentId && r.departmentId !== devDept.id);
    if (otherResident) {
      expect(focus.highlightedResidentIds.has(otherResident.id)).toBe(false);
    }

    /* Street routes run strictly tile-by-tile on city.roads between landmarks:
       zero straight rays to individual agents and zero head_guide / checker spaghetti. */
    const kinds = new Set<string>(focus.links.map(l => l.kind));
    expect(kinds.has('handoff')).toBe(true);
    expect(kinds.has('statue')).toBe(true);
    expect(kinds.has('one_shot')).toBe(true);
    expect(kinds.has('head_guide')).toBe(false);
    expect(kinds.has('checker')).toBe(false);
    expect(focus.links.length).toBeGreaterThanOrEqual(2);
    expect(focus.links.length).toBeLessThanOrEqual(3);

    for (const link of focus.links) {
      expect(link.path.length).toBeGreaterThanOrEqual(2);
      expect(isLinkStrictlyOnRoads(synced.city, link), `link ${link.id} must stay strictly on city.roads`).toBe(true);
    }
  });

  it('contains zero theme-specific words in department-focus core module', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/world/department-focus.ts'), 'utf8');
    expect(/\b(egypt|pharaoh|nile|pyramid|obelisk|dungeon|papyrus)\b/i.test(src)).toBe(false);
  });
});
