import { collectionText, readCollection, withAdded, without, type CustomSkin } from './collection';
import { builtinSkin, DEFAULT_SKIN } from './registry';
import { declarations, type Skin, type SkinLook } from './roles';

/* The skin on the page and the collection of a person's own, kept in this browser. The skin on the page is always one
   that exists: a name the browser kept that names no skin, from an older version or a deleted skin, means Cyberpunk. */

export type SkinsState = { active: string; custom: readonly CustomSkin[] };

const ACTIVE_KEY = 'hh-theme';
const COLLECTION_KEY = 'hh-skins';

let state: SkinsState = { active: DEFAULT_SKIN, custom: [] };
const listeners = new Set<() => void>();

/* Storage can be missing, blocked or full: the skin then still applies for this visit. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const lookIn = (custom: readonly CustomSkin[], id: string): SkinLook | null => builtinSkin(id) ?? custom.find(entry => entry.id === id)?.skin ?? null;

/* Every token of the skin at once, so switching never shows a mix of two skins. */
function apply({ active, custom }: SkinsState): void {
  const look = lookIn(custom, active)!;
  const page = document.documentElement;
  page.dataset.theme = active;
  page.dataset.scheme = look.scheme;
  for (const [property, value] of declarations(look)) page.style.setProperty(property, value);
}

function change(next: SkinsState): void {
  state = next;
  apply(next);
  listeners.forEach(listener => listener());
}

/* Runs before the page draws, from the script at the top of index.html, and again when the app starts. */
export function initSkins(): void {
  const custom = readCollection(stored(COLLECTION_KEY));
  const saved = stored(ACTIVE_KEY) ?? '';
  change({ active: lookIn(custom, saved) ? saved : DEFAULT_SKIN, custom });
}

export const skinsState = (): SkinsState => state;

export function subscribeSkins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* The look of a built-in skin or one of the collection, by its name. */
export const lookOf = (id: string): SkinLook | null => lookIn(state.custom, id);

/* Puts a skin on the page at once and keeps the choice; a name of no skin changes nothing. */
export function chooseSkin(id: string): boolean {
  if (!lookOf(id)) return false;
  keep(ACTIVE_KEY, id);
  change({ ...state, active: id });
  return true;
}

/* Adds skins to the collection after those kept, without turning one on. kept is false when the browser could not keep
   the collection: the skins then stay for this visit only. */
export function keepSkins(skins: readonly Skin[]): { added: CustomSkin[]; over: number; kept: boolean } {
  const { list, added, over } = withAdded(state.custom, skins);
  if (added.length === 0) return { added, over, kept: true };
  const kept = keep(COLLECTION_KEY, collectionText(list));
  change({ ...state, custom: list });
  return { added, over, kept };
}

/* Deletes a skin of the collection; when it was on, Cyberpunk takes its place. A built-in skin stays. */
export function forgetSkin(id: string): void {
  if (!state.custom.some(entry => entry.id === id)) return;
  const custom = without(state.custom, id);
  keep(COLLECTION_KEY, collectionText(custom));
  const active = state.active === id ? DEFAULT_SKIN : state.active;
  if (active !== state.active) keep(ACTIVE_KEY, active);
  change({ active, custom });
}
