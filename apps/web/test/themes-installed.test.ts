/* A theme the company installed from an archive, as the page puts it on (docs/theme-archive.md, 10): its look passes the
   skin check before it is kept, its world registers as a pack written as data, and its fonts load from the store through
   the browser's FontFace, once a version, and go again when the theme is deleted. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinSkin } from '../src/skins/registry';
import { installedLookOf } from '../src/skins/store';
import { forgetInstalledTheme, keepInstalledTheme, type InstalledThemeLook } from '../src/themes/installed';
import { dataOfWorldPack } from '../src/world-packs/data-pack';
import { resolveWorldPack } from '../src/world-packs/registry';

const pixel = builtinSkin('pixel')!;
const LOOK = Object.fromEntries(Object.entries(pixel).filter(([key]) => key !== 'id' && key !== 'world'));
const BASE = '/api/themes/files/night-shift/1.0.0/';
const FACES = [
  { family: 'Night Sans', file: 'night sans.woff2', weight: 400, style: 'normal' as const },
  { family: 'Night Sans', file: 'night-sans-cyr.woff2', weight: 700, style: 'italic' as const, unicodeRange: 'U+0400-04FF' },
];
const theme = (over: Partial<InstalledThemeLook> = {}): InstalledThemeLook => ({ id: 'night-shift', version: '1.0.0', base: BASE, look: LOOK, fonts: FACES, kit: null, world: null, ...over });

class Face {
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {}
}

describe('a theme installed from an archive, on the page', () => {
  const fonts = { add: vi.fn(), delete: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal('FontFace', Face);
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });

  afterEach(() => {
    forgetInstalledTheme('night-shift');
    vi.unstubAllGlobals();
    fonts.add.mockReset();
    fonts.delete.mockReset();
  });

  it('loads its fonts from the store as WOFF2 faces, once a version', () => {
    expect(keepInstalledTheme(theme())).toBe(true);
    const added = fonts.add.mock.calls.map(([face]) => face as Face);
    expect(added.map(face => [face.family, face.source, face.descriptors])).toEqual([
      ['Night Sans', 'url("/api/themes/files/night-shift/1.0.0/ui/fonts/night%20sans.woff2") format("woff2")', { weight: '400', style: 'normal', display: 'swap' }],
      ['Night Sans', 'url("/api/themes/files/night-shift/1.0.0/ui/fonts/night-sans-cyr.woff2") format("woff2")', { weight: '700', style: 'italic', display: 'swap', unicodeRange: 'U+0400-04FF' }],
    ]);
    expect(installedLookOf('night-shift')?.world).toBe('standard');

    expect(keepInstalledTheme(theme())).toBe(true);
    expect(fonts.add).toHaveBeenCalledTimes(2);
    expect(keepInstalledTheme(theme({ version: '1.1.0', base: '/api/themes/files/night-shift/1.1.0/' }))).toBe(true);
    expect(fonts.add).toHaveBeenCalledTimes(4);
  });

  it('takes away its look, its world and the fonts of every version when the company deletes it', () => {
    keepInstalledTheme(theme({ world: dataOfWorldPack(resolveWorldPack('space')!) }));
    keepInstalledTheme(theme({ version: '1.1.0' }));
    expect(fonts.add).toHaveBeenCalledTimes(4);

    forgetInstalledTheme('night-shift');
    expect(fonts.delete.mock.calls.map(([face]) => face)).toEqual(fonts.add.mock.calls.map(([face]) => face));
    expect(installedLookOf('night-shift')).toBeNull();
    expect(resolveWorldPack('night-shift')).toBeNull();
    keepInstalledTheme(theme());
    expect(fonts.add).toHaveBeenCalledTimes(6);
  });

  it('puts a world written as data in place, under the theme', () => {
    expect(keepInstalledTheme(theme({ world: dataOfWorldPack(resolveWorldPack('space')!) }))).toBe(true);
    expect(installedLookOf('night-shift')?.world).toBe('night-shift');
    expect(resolveWorldPack('night-shift')?.id).toBe('night-shift');
  });

  it('keeps nothing, and loads no font, of a look or a world that does not pass its check', () => {
    expect(keepInstalledTheme(theme({ look: { ...LOOK, scheme: 'sepia' } }))).toBe(false);
    expect(keepInstalledTheme(theme({ world: { mapSize: 100_000 } }))).toBe(false);
    expect(installedLookOf('night-shift')).toBeNull();
    expect(resolveWorldPack('night-shift')).toBeNull();
    expect(fonts.add).not.toHaveBeenCalled();
  });

  it('loads no font where the browser has no FontFace, and still puts the look on', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('FontFace', undefined);
    expect(keepInstalledTheme(theme())).toBe(true);
    expect(fonts.add).not.toHaveBeenCalled();
    expect(installedLookOf('night-shift')).not.toBeNull();
  });
});
