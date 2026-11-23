/* Theme-agnostic server world pack registry. Looks up active world skills and allowed
   company themes strictly from registered packs without hardcoding theme rules in core code. */

import {
  STANDARD_COMPANY_THEMES,
  type WorldPackBehaviorSpec,
  type WorldPackSkillSpec,
} from '@hornhoof/protocol/world';
import { EGYPT_WORLD_PACK } from './egypt.js';

export type WorldPackRegistry = ReadonlyMap<string, WorldPackBehaviorSpec>;

export function createWorldPackRegistry(packs: readonly WorldPackBehaviorSpec[]): WorldPackRegistry {
  return new Map(packs.map(pack => [pack.id, pack]));
}

/* Built-in product world packs enabled on the server by default. */
export function defaultWorldPacks(): WorldPackRegistry {
  return createWorldPackRegistry([EGYPT_WORLD_PACK]);
}

export function worldPackForTheme(
  packs: WorldPackRegistry | undefined,
  theme: string | null | undefined,
): WorldPackBehaviorSpec | null {
  if (!packs || !theme) return null;
  return packs.get(theme) ?? null;
}

export function worldSkillsForTheme(
  packs: WorldPackRegistry | undefined,
  theme: string | null | undefined,
): readonly WorldPackSkillSpec[] {
  return worldPackForTheme(packs, theme)?.skills ?? [];
}

const STANDARD_SET: ReadonlySet<string> = new Set(STANDARD_COMPANY_THEMES);

export function isAllowedCompanyTheme(packs: WorldPackRegistry | undefined, theme: string): boolean {
  return STANDARD_SET.has(theme) || Boolean(packs?.has(theme));
}
