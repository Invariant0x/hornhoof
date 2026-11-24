import type { Skin, SkinNames } from './roles';
import { parseSkin, skinObject } from './validate';

/* The skins a person added, as a list kept in their browser. Each has a number of its own, so two files of the same
   name never take each other's place, and a new skin always gets a number above every one kept. */

export type CustomSkin = { id: string; skin: Skin };
export const COLLECTION_LIMIT = 30;
const ID = /^custom-[1-9][0-9]{0,5}$/;

const numberOf = (id: string) => Number(id.slice('custom-'.length));
const nextId = (list: readonly CustomSkin[]) => `custom-${list.reduce((top, entry) => Math.max(top, numberOf(entry.id)), 0) + 1}`;
const isEntry = (value: unknown): value is { id: string; skin?: unknown } => typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';

/* The list with the skin added after the ones kept; null when the list is full. */
export function withAdded(list: readonly CustomSkin[], skin: Skin): { list: CustomSkin[]; entry: CustomSkin } | null {
  if (list.length >= COLLECTION_LIMIT) return null;
  const entry = { id: nextId(list), skin };
  return { list: [...list, entry], entry };
}

export const without = (list: readonly CustomSkin[], id: string): CustomSkin[] => list.filter(entry => entry.id !== id);

/* A deleted skin back at its place. Its number goes to a skin added since, if one took it; it then gets a new one. */
export function withRestored(list: readonly CustomSkin[], entry: CustomSkin, at: number): { list: CustomSkin[]; entry: CustomSkin } {
  const back = list.some(kept => kept.id === entry.id) ? { ...entry, id: nextId(list) } : entry;
  return { list: [...list.slice(0, at), back, ...list.slice(at)], entry: back };
}

/* Names that a card already shows get a number, (2), (3) and on, in every language at once, so every card can be told
   apart. */
export function uniqueName(name: SkinNames, taken: readonly SkinNames[]): SkinNames {
  const used = new Set(taken.flatMap(other => Object.values(other)));
  for (let n = 1; ; n += 1) {
    const next = n === 1 ? name : (Object.fromEntries(Object.entries(name).map(([language, own]) => [language, `${own} (${n})`])) as SkinNames);
    if (!Object.values(next).some(own => used.has(own))) return next;
  }
}

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
