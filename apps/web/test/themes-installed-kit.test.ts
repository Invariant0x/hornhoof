import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtinSkin } from '../src/skins/registry';
import { chooseSkin, initSkins } from '../src/skins/store';
import { forgetInstalledTheme, keepInstalledTheme, type InstalledThemeLook } from '../src/themes/installed';

/* An installed theme's kit (#1970) goes on the page with the theme and only with it: its parts come from the theme's own
   files on the server, and another theme, or the theme deleted, leaves no trace of them. */

const page = document.documentElement;
const kitVariables = () => [...page.style].filter(name => name.startsWith('--kit-')).sort();

/* A built-in skin's look as a ui/look.json holds it. */
const lookFile = (id: string): Record<string, unknown> => {
  const raw = JSON.parse(JSON.stringify(builtinSkin(id))) as Record<string, unknown>;
  delete raw.id;
  delete raw.world;
  return raw;
};

const theme = (id: string, kit: unknown): InstalledThemeLook => ({
  id,
  version: '1.0.0',
  base: `/api/themes/files/${id}/1.0.0/`,
  look: lookFile('egypt'),
  fonts: [],
  kit,
  world: null,
});

const KIT = {
  slots: { btn: { file: 'btn@2x.webp', slice: '18 fill', width: '9px' }, panel: { file: 'panel.weave@2x.webp', size: '96px 96px' } },
  colors: { 'tab-ink': '#502704' },
};

beforeEach(() => {
  localStorage.clear();
  initSkins();
});
afterEach(() => {
  for (const id of ['sand-kit', 'sand-plain', 'sand-broken']) forgetInstalledTheme(id);
  chooseSkin('cyberpunk');
});

describe('the kit of an installed theme', () => {
  it('goes on the page when its theme is put on, with pictures from that theme on the server', () => {
    expect(keepInstalledTheme(theme('sand-kit', KIT))).toBe(true);
    expect(page.dataset.kit).toBeUndefined();
    chooseSkin('sand-kit');
    expect(page.dataset.kit).toBe('on');
    expect(page.dataset.kitFaces).toBe('btn');
    expect(page.style.getPropertyValue('--kit-btn')).toBe('url("/api/themes/files/sand-kit/1.0.0/ui/kit/btn%402x.webp")');
    expect(page.style.getPropertyValue('--kit-c-tab-ink')).toBe('#502704');
  });

  it('comes on at once when the look of the theme already on arrives later', () => {
    chooseSkin('cyberpunk');
    keepInstalledTheme(theme('sand-kit', KIT));
    localStorage.setItem('hh-theme', 'sand-kit');
    initSkins();
    expect(page.dataset.kit).toBe('on');
  });

  it('leaves no mark and no variable once another theme, built-in or installed without a kit, is on', () => {
    keepInstalledTheme(theme('sand-kit', KIT));
    keepInstalledTheme(theme('sand-plain', null));
    chooseSkin('sand-kit');
    chooseSkin('sand-plain');
    expect(page.dataset.kit).toBeUndefined();
    expect(page.dataset.kitFaces).toBeUndefined();
    expect(kitVariables()).toEqual([]);
    chooseSkin('sand-kit');
    chooseSkin('egypt');
    expect(page.dataset.kit).toBeUndefined();
    expect(kitVariables()).toEqual([]);
  });

  it('takes the kit away with the theme when the company deletes it', () => {
    keepInstalledTheme(theme('sand-kit', KIT));
    chooseSkin('sand-kit');
    forgetInstalledTheme('sand-kit');
    expect(page.dataset.theme).toBe('cyberpunk');
    expect(page.dataset.kit).toBeUndefined();
    expect(kitVariables()).toEqual([]);
  });

  it('puts the theme on without a kit when what the server gave as its kit is not one', () => {
    for (const kit of ['btn.png', [KIT], { slots: 'btn' }, { slots: null }, { colors: KIT.colors }, { slots: [KIT.slots.btn] }]) {
      expect(keepInstalledTheme(theme('sand-broken', kit)), JSON.stringify(kit)).toBe(true);
      chooseSkin('sand-broken');
      expect(page.dataset.theme).toBe('sand-broken');
      expect(page.dataset.kit, JSON.stringify(kit)).toBeUndefined();
      expect(kitVariables(), JSON.stringify(kit)).toEqual([]);
      chooseSkin('cyberpunk');
    }
  });
});
