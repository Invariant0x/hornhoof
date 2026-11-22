/* Pack-agnostic registry mapping active world theme IDs to their isometric WorldPackManifest.
   Product screens look up packs exclusively through this registry so zero theme words leak into core UI. */

import type { WorldPackManifest } from '../world/manifest';
import { DUNGEON_WORLD_PACK } from './dungeon/pack';
import { EGYPT_WORLD_PACK } from './egypt/pack';

const WORLD_PACKS: Readonly<Record<string, WorldPackManifest>> = {
  egypt: EGYPT_WORLD_PACK,
  dungeon: DUNGEON_WORLD_PACK,
};

export function resolveWorldPack(worldId: string | null | undefined): WorldPackManifest | null {
  if (!worldId || worldId === 'standard') return null;
  return WORLD_PACKS[worldId] ?? null;
}

export function registeredWorldPackIds(): readonly string[] {
  return Object.keys(WORLD_PACKS);
}
