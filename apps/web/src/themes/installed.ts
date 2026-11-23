/* The themes the company installed from archives (docs/theme-archive.md, 10), as the screens put them on: the look goes
   through the same skin check as on the server, before a value of it reaches the page; the fonts load from the server
   through the browser's FontFace, never as CSS; the world registers as a pack written as data. */

import type { InstalledThemeView } from '@hornhoof/protocol/themes';
import { api } from '../api';
import { kitOf } from '../skins/kit';
import { forgetInstalledLook, installedLookOf, keepInstalledLook } from '../skins/store';
import { parseLook } from '../skins/validate';
import { worldPackOfData } from '../world-packs/data-pack';
import { forgetInstalledWorldPack, registerInstalledWorldPack } from '../world-packs/registry';

type Face = Readonly<{ family: string; file: string; weight: number; style: 'normal' | 'italic'; unicodeRange?: string }>;
export type InstalledThemeLook = Readonly<{ id: string; version: string; base: string; look: unknown; fonts: readonly Face[]; kit: unknown; world: unknown }>;

export const installedThemes = async (): Promise<InstalledThemeView[]> => (await api.get<{ themes: InstalledThemeView[] }>('/api/themes')).themes;

/* The font faces of each theme put on, so a theme put on again loads none twice. */
const loadedFonts = new Map<string, FontFace[]>();

function loadFonts(theme: InstalledThemeLook): void {
  const key = `${theme.id}@${theme.version}`;
  if (loadedFonts.has(key) || typeof FontFace === 'undefined') return;
  const faces = theme.fonts.map(face => new FontFace(face.family, `url("${theme.base}ui/fonts/${encodeURIComponent(face.file)}") format("woff2")`, {
    weight: String(face.weight),
    style: face.style,
    display: 'swap',
    ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
  }));
  for (const face of faces) document.fonts.add(face);
  loadedFonts.set(key, faces);
}

/* Reads an installed theme's look and world and keeps them for the page; false when either does not pass its check. */
export function keepInstalledTheme(theme: InstalledThemeLook): boolean {
  const look = parseLook(theme.look, theme.fonts.map(face => face.family));
  if (!look.ok) return false;
  let world = 'standard';
  if (theme.world) {
    const pack = worldPackOfData(theme.id, theme.world, `${theme.base}world/art/`);
    if (!pack.ok) return false;
    registerInstalledWorldPack(pack.pack);
    world = theme.id;
  } else {
    forgetInstalledWorldPack(theme.id);
  }
  loadFonts(theme);
  const kit = kitOf(theme.kit);
  keepInstalledLook(theme.id, { ...look.look, world }, kit ? { kit, base: theme.base } : null);
  return true;
}

/* Puts the look of an installed theme within reach of the page, once; a theme that is not installed, or no longer
   passes its check, changes nothing. */
export async function loadInstalledTheme(id: string): Promise<boolean> {
  if (installedLookOf(id)) return true;
  try {
    return keepInstalledTheme(await api.get<InstalledThemeLook>(`/api/themes/${encodeURIComponent(id)}/look`));
  } catch {
    return false;
  }
}

/* Forgets a theme the company deleted: its look, its world and its fonts. */
export function forgetInstalledTheme(id: string): void {
  forgetInstalledLook(id);
  forgetInstalledWorldPack(id);
  for (const [key, faces] of loadedFonts) {
    if (!key.startsWith(`${id}@`)) continue;
    for (const face of faces) document.fonts.delete(face);
    loadedFonts.delete(key);
  }
}
