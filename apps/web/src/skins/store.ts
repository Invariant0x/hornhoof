import { COLLECTION_LIMIT, collectionText, readCollection, withAdded, withRestored, without, type CustomSkin } from './collection';
import { builtinSkin, DEFAULT_SKIN, ownLook } from './registry';
import { declarations, extraDeclarations, type Skin, type SkinLook, type WorldKind } from './roles';

/* The skin on the page and the collection of a person's own, kept in this browser. The skin on the page is always one
   that exists: a name the browser kept that names no skin, from an older version or a deleted skin, means Cyberpunk. */

type SkinsState = { active: string; custom: readonly CustomSkin[] };
/* A skin just deleted, as much as it takes to put it back: where it stood, and whether it was on. */
export type Removal = { entry: CustomSkin; at: number; wasOn: boolean; choice: number };
export type Added = { ok: true; entry: CustomSkin } | { ok: false; reason: 'full' | 'not_kept' };

const ACTIVE_KEY = 'hh-theme';
const COLLECTION_KEY = 'hh-skins';

let state: SkinsState = { active: DEFAULT_SKIN, custom: [] };
/* How many times a person picked a skin, so putting a deleted skin back knows whether they chose another since. */
let choices = 0;
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

function lookIn(custom: readonly CustomSkin[], id: string): SkinLook | null {
  const own = custom.find(entry => entry.id === id);
  return builtinSkin(id) ?? (own ? ownLook(own.skin) : null);
}

/* Every token and root attribute of the skin at once, so switching never shows a mix of two themes. */
function apply({ active, custom }: SkinsState): void {
  const look = lookIn(custom, active)!;
  const page = document.documentElement;
  page.dataset.theme = active;
  page.dataset.scheme = look.scheme;
  page.dataset.cut = look.shape;
  if (look.world && look.world !== 'standard') page.dataset.world = look.world;
  else delete page.dataset.world;
  if (look.surface && look.surface !== 'plain') page.dataset.surface = look.surface;
  else delete page.dataset.surface;
  for (const [property, value] of declarations(look)) page.style.setProperty(property, value);
  const extra = extraDeclarations(look);
  for (const property of extra.clear) page.style.removeProperty(property);
  for (const [property, value] of extra.set) page.style.setProperty(property, value);
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

/* The active skin's full look and interactive world kind. */
export const activeLook = (): SkinLook => lookIn(state.custom, state.active)!;
export const activeWorld = (): WorldKind => activeLook().world ?? 'standard';

/* Puts a skin on the page at once and keeps the choice; a name of no skin changes nothing. */
export function chooseSkin(id: string): boolean {
  if (!lookOf(id)) return false;
  choices += 1;
  keep(ACTIVE_KEY, id);
  change({ ...state, active: id });
  return true;
}

/* Adds a skin after those kept, without turning it on. It is added only when the browser kept it: a person is never told
   a skin was added that the next visit would not have. */
export function addSkin(skin: Skin): Added {
  const added = withAdded(state.custom, skin);
  if (!added) return { ok: false, reason: 'full' };
  if (!keep(COLLECTION_KEY, collectionText(added.list))) return { ok: false, reason: 'not_kept' };
  change({ ...state, custom: added.list });
  return { ok: true, entry: added.entry };
}

/* Deletes a skin of the collection at once; when it was on, Cyberpunk takes its place. A built-in skin stays. */
export function removeSkin(id: string): Removal | null {
  const at = state.custom.findIndex(entry => entry.id === id);
  if (at < 0) return null;
  const removal = { entry: state.custom[at]!, at, wasOn: state.active === id, choice: choices };
  const custom = without(state.custom, id);
  keep(COLLECTION_KEY, collectionText(custom));
  if (removal.wasOn) keep(ACTIVE_KEY, DEFAULT_SKIN);
  change({ active: removal.wasOn ? DEFAULT_SKIN : state.active, custom });
  return removal;
}

/* Puts a deleted skin back at its place. It is on again only if it was on and the person has picked no skin since. */
export function restoreSkin(removal: Removal): CustomSkin | null {
  if (state.custom.length >= COLLECTION_LIMIT) return null;
  const back = withRestored(state.custom, removal.entry, removal.at);
  if (!keep(COLLECTION_KEY, collectionText(back.list))) return null;
  const on = removal.wasOn && removal.choice === choices;
  if (on) keep(ACTIVE_KEY, back.entry.id);
  change({ active: on ? back.entry.id : state.active, custom: back.list });
  return back.entry;
}
