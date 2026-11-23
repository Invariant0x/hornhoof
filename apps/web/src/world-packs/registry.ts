/* Pack-agnostic registry mapping active world theme IDs to their isometric WorldPackManifest.
   Product screens look up packs exclusively through this registry so zero theme words leak into core UI. */

import type { WorldPackManifest } from '../world/manifest';
import { DUNGEON_WORLD_PACK } from './dungeon/pack';
import { EGYPT_WORLD_PACK } from './egypt/pack';
import { SPACE_WORLD_PACK } from './space/pack';

const WORLD_PACKS: Readonly<Record<string, WorldPackManifest>> = {
  egypt: EGYPT_WORLD_PACK,
  dungeon: DUNGEON_WORLD_PACK,
  space: SPACE_WORLD_PACK,
};

/* Worlds of themes the company installed, written as data (data-pack.ts): each stands in place of a shipped pack of its id. */
const installed = new Map<string, WorldPackManifest>();

export function registerInstalledWorldPack(pack: WorldPackManifest): void {
  installed.set(pack.id, pack);
}

export function forgetInstalledWorldPack(id: string): void {
  installed.delete(id);
}

export function resolveWorldPack(worldId: string | null | undefined): WorldPackManifest | null {
  if (!worldId || worldId === 'standard') return null;
  return installed.get(worldId) ?? (Object.hasOwn(WORLD_PACKS, worldId) ? WORLD_PACKS[worldId]! : null);
}

export function registeredWorldPackIds(): readonly string[] {
  return Object.keys(WORLD_PACKS);
}

/* Every registered pack in registration order; demo pages list these, so a new pack needs no page edits. */
export function registeredWorldPacks(): readonly WorldPackManifest[] {
  return Object.values(WORLD_PACKS);
}

/* The pack named in a page address, or the first registered pack. */
export function worldPackFromParam(raw: string | null | undefined): WorldPackManifest {
  return (raw ? WORLD_PACKS[raw] : undefined) ?? Object.values(WORLD_PACKS)[0]!;
}
