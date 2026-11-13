import type { Skin } from './roles';
import { parseSkin, skinObject } from './validate';

/* The skins a person loaded, as a list kept in their browser. Each has a number of its own, so two files of the same
   name never take each other's place, and a new skin always gets a number above every one kept. */

export type CustomSkin = { id: string; skin: Skin };
export const COLLECTION_LIMIT = 30;
const ID = /^custom-[1-9][0-9]{0,5}$/;

export const isCustomId = (id: string) => ID.test(id);
const numberOf = (id: string) => Number(id.slice('custom-'.length));
const isEntry = (value: unknown): value is { id: string; skin?: unknown } => typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';

/* The list with the skins added after the ones kept, as many as there is room for; over counts those left out. */
export function withAdded(list: readonly CustomSkin[], skins: readonly Skin[]): { list: CustomSkin[]; added: CustomSkin[]; over: number } {
  const room = Math.max(0, COLLECTION_LIMIT - list.length);
  let last = list.reduce((top, entry) => Math.max(top, numberOf(entry.id)), 0);
  const added = skins.slice(0, room).map(skin => ({ id: `custom-${(last += 1)}`, skin }));
  return { list: [...list, ...added], added, over: skins.length - added.length };
}

export const without = (list: readonly CustomSkin[], id: string): CustomSkin[] => list.filter(entry => entry.id !== id);

export const collectionText = (list: readonly CustomSkin[]): string => JSON.stringify(list.map(({ id, skin }) => ({ id, skin: skinObject(skin) })));

function readList(text: string | null): unknown[] {
  try {
    const raw: unknown = JSON.parse(text ?? '');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/* What the browser kept, checked again as strictly as a file: an entry it cannot trust is left out, never repaired. */
export function readCollection(text: string | null): CustomSkin[] {
  const list: CustomSkin[] = [];
  for (const entry of readList(text)) {
    if (!isEntry(entry) || !ID.test(entry.id) || list.some(kept => kept.id === entry.id)) continue;
    const parsed = parseSkin(JSON.stringify(entry.skin ?? null));
    if (parsed.ok) list.push({ id: entry.id, skin: parsed.skin });
  }
  return list.slice(0, COLLECTION_LIMIT);
}
