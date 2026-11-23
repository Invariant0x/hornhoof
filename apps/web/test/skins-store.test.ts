import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLECTION_LIMIT, collectionText, readCollection, uniqueName, withAdded, withRestored, without, type CustomSkin } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin, ownLook } from '../src/skins/registry';
import { COLOR_TOKENS, CUT_TOKEN, FONT_TOKENS, SKIN_PROPERTIES, TERMINAL_PROPERTIES, WORLD_COLOR_TOKENS, WORLD_PROPERTIES, type Skin } from '../src/skins/roles';
import { activeWorld, addSkin, chooseSkin, initSkins, lookOf, mapGrain, removeSkin, restoreSkin, setMapGrain, skinsState, subscribeSkins } from '../src/skins/store';
import { builtinFile, skinText } from '../src/skins/validate';

const root = document.documentElement;
const skin = (name: string, bg = '#010203', base = 'matrix'): Skin => {
  const file = builtinFile(builtinSkin('matrix')!, { ru: name, en: name });
  return { ...file, base, colors: { ...file.colors, bg } };
};
const inline = () => Object.fromEntries(SKIN_PROPERTIES.map(property => [property, root.style.getPropertyValue(property)]).filter(([, value]) => value));
const added = (list: readonly CustomSkin[], ...skins: Skin[]) => skins.reduce<CustomSkin[]>((into, next) => withAdded(into, next)!.list, [...list]);
const ids = () => skinsState().custom.map(entry => entry.id);
const fullStorage = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });

function clearPage() {
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.cut;
  delete root.dataset.world;
  delete root.dataset.surface;
  delete root.dataset.grain;
  root.removeAttribute('style');
}

/* A new visit: the page starts clean and reads what the browser kept. */
function nextVisit() {
  clearPage();
  initSkins();
}

beforeEach(() => {
  localStorage.clear();
  nextVisit();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  clearPage();
});

describe('the collection of skins of a person', () => {
  it('adds one skin at a time after the ones kept, each under a number of its own, even when names repeat', () => {
    const first = withAdded([], skin('Dusk'))!;
    expect(first.entry.id).toBe('custom-1');
    const list = added(first.list, skin('Dusk', '#020304'), skin('Dawn'));
    expect(list.map(entry => [entry.id, entry.skin.name.en])).toEqual([['custom-1', 'Dusk'], ['custom-2', 'Dusk'], ['custom-3', 'Dawn']]);
  });

  it('gives a new skin a number above every one kept, so a deleted number is never mixed up with a new skin', () => {
    const list = added([], skin('A'), skin('B'), skin('C'));
    expect(withAdded(without(list, 'custom-2'), skin('D'))!.entry.id).toBe('custom-4');
  });

  it(`holds at most ${COLLECTION_LIMIT} skins`, () => {
    const full = added([], ...Array.from({ length: COLLECTION_LIMIT }, (_, i) => skin(`S${i}`)));
    expect(full).toHaveLength(COLLECTION_LIMIT);
    expect(withAdded(full, skin('More'))).toBeNull();
  });

  it('puts a deleted skin back at its place, under a new number if a skin added since took its own', () => {
    const list = added([], skin('A'), skin('B'), skin('C'));
    const b = list[1]!;
    expect(withRestored(without(list, b.id), b, 1)).toEqual({ list, entry: b });
    const taken = withAdded(without(list, 'custom-3'), skin('D'))!.list;
    const c = list[2]!;
    expect(withRestored(taken, c, 2).entry).toEqual({ ...c, id: 'custom-4' });
    expect(withRestored(taken, c, 2).list.map(entry => entry.skin.name.en)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('numbers a name a card already shows, in both languages at once', () => {
    const taken = [{ ru: 'Киберпанк', en: 'Cyberpunk' }, { ru: 'Сумерки', en: 'Dusk' }, { ru: 'Сумерки (2)', en: 'Dusk (2)' }];
    expect(uniqueName({ ru: 'Рассвет', en: 'Dawn' }, taken)).toEqual({ ru: 'Рассвет', en: 'Dawn' });
    expect(uniqueName({ ru: 'Киберпанк', en: 'Cyberpunk' }, taken)).toEqual({ ru: 'Киберпанк (2)', en: 'Cyberpunk (2)' });
    expect(uniqueName({ ru: 'Сумерки', en: 'Twilight' }, taken)).toEqual({ ru: 'Сумерки (3)', en: 'Twilight (3)' });
  });

  it('reads back what it wrote, and drops a broken, unsafe, repeated or foreign entry instead of trusting it', () => {
    const list = added([], skin('Dusk'), skin('Dawn'));
    expect(readCollection(collectionText(list))).toEqual(list);
    const unsafe = { id: 'custom-7', skin: { ...JSON.parse(skinText(skin('Bad'))), colors: { ...skin('Bad').colors, bg: 'url(x)' } } };
    const old = { id: 'custom-8', skin: { format: 'hornhoof-skin', version: 1, name: 'Old', scheme: 'dark', colors: skin('Old').colors, fonts: skin('Old').fonts, cut: 1 } };
    const text = JSON.stringify([
      ...JSON.parse(collectionText(list)),
      unsafe,
      old,
      { id: 'custom-1', skin: JSON.parse(skinText(skin('Again'))) },
      { id: 'cyberpunk', skin: JSON.parse(skinText(skin('Fake'))) },
      { id: '__proto__', skin: {} },
      'x',
      null,
    ]);
    expect(readCollection(text)).toEqual(list);
    for (const broken of [null, '', 'not json', '{}', '"x"', '[[]]']) expect(readCollection(broken), String(broken)).toEqual([]);
  });
});

describe('the skin on the page', () => {
  it('starts in Cyberpunk, dark, before a person picks anything, whatever the system prefers', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: light)' }));
    nextVisit();
    expect(skinsState().active).toBe('cyberpunk');
    expect([root.dataset.theme, root.dataset.scheme, root.dataset.cut]).toEqual(['cyberpunk', 'dark', 'bevel']);
    expect(inline()[COLOR_TOKENS.bg]).toBe(builtinSkin('cyberpunk')!.colors.bg);
    expect(inline()['color-scheme']).toBe('dark');
    vi.unstubAllGlobals();
  });

  it.each(BUILTIN_SKINS.map(entry => entry.id))('switches to %s at once, sets all its tokens and the shape of its cut, and keeps it for the next visit', id => {
    expect(chooseSkin(id)).toBe(true);
    const look = builtinSkin(id)!;
    expect([root.dataset.theme, root.dataset.scheme, root.dataset.cut]).toEqual([id, look.scheme, look.shape]);
    expect(Object.keys(inline()).sort()).toEqual([...SKIN_PROPERTIES].sort());
    expect(inline()[COLOR_TOKENS.surface]).toBe(look.colors.surface);
    expect(inline()[COLOR_TOKENS.scrim]).toBe(look.colors.scrim);
    expect(inline()[CUT_TOKEN]).toBe(String(look.cut));
    expect(localStorage.getItem('hh-theme')).toBe(id);
    nextVisit();
    expect(skinsState().active).toBe(id);
    expect(root.dataset.theme).toBe(id);
  });

  it('takes a name it does not know, from an older version, Neon or a deleted skin, as Cyberpunk', () => {
    for (const saved of ['dark', 'neon', 'custom', 'custom-9', '__proto__', 'constructor', '']) {
      localStorage.setItem('hh-theme', saved);
      nextVisit();
      expect(skinsState().active, saved).toBe('cyberpunk');
      expect(root.dataset.theme).toBe('cyberpunk');
    }
  });

  it('ignores a choice of a skin that is not there and leaves the page as it is', () => {
    chooseSkin('matrix');
    expect(chooseSkin('custom-1')).toBe(false);
    expect(chooseSkin('toString')).toBe(false);
    expect(root.dataset.theme).toBe('matrix');
    expect(localStorage.getItem('hh-theme')).toBe('matrix');
  });

  it('adds skins without turning one on, and puts a chosen one on the page in full, with the cut of its base', () => {
    chooseSkin('light');
    expect(addSkin(skin('Dusk'))).toEqual({ ok: true, entry: { id: 'custom-1', skin: skin('Dusk') } });
    addSkin(skin('Dawn', '#0A0B0C', 'pixel'));
    expect(skinsState().active).toBe('light');
    expect(root.dataset.theme).toBe('light');
    addSkin(skin('Noon'));
    expect(skinsState().custom.map(entry => entry.skin.name.en)).toEqual(['Dusk', 'Dawn', 'Noon']);
    chooseSkin('custom-2');
    expect([root.dataset.theme, root.dataset.scheme, root.dataset.cut]).toEqual(['custom-2', 'dark', 'steps']);
    expect(inline()[COLOR_TOKENS.bg]).toBe('#0A0B0C');
    expect(inline()[FONT_TOKENS.display]).toBe("'Tektur', 'Onest', system-ui, sans-serif");
    nextVisit();
    expect(skinsState().active).toBe('custom-2');
    expect(ids()).toEqual(['custom-1', 'custom-2', 'custom-3']);
    expect(inline()[COLOR_TOKENS.bg]).toBe('#0A0B0C');
  });

  it('never says a skin was added that the browser did not keep, and leaves the collection as it was', () => {
    addSkin(skin('Dusk'));
    fullStorage();
    expect(addSkin(skin('Dawn'))).toEqual({ ok: false, reason: 'not_kept' });
    expect(ids()).toEqual(['custom-1']);
  });

  it(`refuses a skin over ${COLLECTION_LIMIT} as a full collection`, () => {
    for (let i = 0; i < COLLECTION_LIMIT; i += 1) addSkin(skin(`S${i}`));
    expect(addSkin(skin('More'))).toEqual({ ok: false, reason: 'full' });
    expect(skinsState().custom).toHaveLength(COLLECTION_LIMIT);
  });

  it('deletes a skin at once; deleting the one that is on turns Cyberpunk on', () => {
    addSkin(skin('Dusk'));
    addSkin(skin('Dawn'));
    chooseSkin('custom-1');
    expect(removeSkin('custom-2')).toMatchObject({ at: 1, wasOn: false, entry: { id: 'custom-2' } });
    expect(skinsState()).toEqual({ active: 'custom-1', custom: [{ id: 'custom-1', skin: skin('Dusk') }] });
    expect(removeSkin('custom-1')).toMatchObject({ at: 0, wasOn: true });
    expect(skinsState()).toEqual({ active: 'cyberpunk', custom: [] });
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(localStorage.getItem('hh-theme')).toBe('cyberpunk');
    nextVisit();
    expect(skinsState()).toEqual({ active: 'cyberpunk', custom: [] });
  });

  it('puts a deleted skin back at its place, and on again only when the person picked no other skin since', () => {
    addSkin(skin('Dusk'));
    addSkin(skin('Dawn'));
    addSkin(skin('Noon'));
    chooseSkin('custom-2');
    const removal = removeSkin('custom-2')!;
    expect(restoreSkin(removal)).toEqual({ id: 'custom-2', skin: skin('Dawn') });
    expect(skinsState()).toMatchObject({ active: 'custom-2' });
    expect(ids()).toEqual(['custom-1', 'custom-2', 'custom-3']);
    nextVisit();
    expect(skinsState().active).toBe('custom-2');

    const again = removeSkin('custom-2')!;
    chooseSkin('light');
    restoreSkin(again);
    expect(skinsState().active).toBe('light');
    expect(ids()).toEqual(['custom-1', 'custom-2', 'custom-3']);
  });

  it('puts nothing back when the browser cannot keep it', () => {
    addSkin(skin('Dusk'));
    const removal = removeSkin('custom-1')!;
    fullStorage();
    expect(restoreSkin(removal)).toBeNull();
    expect(skinsState().custom).toEqual([]);
  });

  it('never deletes a built-in skin', () => {
    chooseSkin('pixel');
    expect(removeSkin('pixel')).toBeNull();
    expect(skinsState().active).toBe('pixel');
    expect(lookOf('pixel')).toBe(builtinSkin('pixel'));
  });

  it('gives the look of any skin by its name, and nothing for one that is not there', () => {
    addSkin(skin('Dusk', '#010203', 'pixel'));
    expect(lookOf('custom-1')).toEqual(ownLook(skin('Dusk', '#010203', 'pixel')));
    expect(lookOf('custom-1')).toMatchObject({ shape: 'steps', colors: { bg: '#010203' } });
    expect(lookOf('custom-2')).toBeNull();
    expect(lookOf('hasOwnProperty')).toBeNull();
  });

  it('still starts when the browser blocks its storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    nextVisit();
    expect(skinsState()).toEqual({ active: 'cyberpunk', custom: [] });
  });

  it('tells those who listen when the skin or the collection changes', () => {
    const heard = vi.fn();
    const stop = subscribeSkins(heard);
    chooseSkin('matrix');
    addSkin(skin('Dusk'));
    const removal = removeSkin('custom-1')!;
    restoreSkin(removal);
    expect(heard).toHaveBeenCalledTimes(4);
    stop();
    chooseSkin('light');
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it('switches to Ancient Egypt with its world and surface attributes, and switching back restores the previous theme without a trace', () => {
    for (const previous of ['cyberpunk', 'matrix', 'light', 'pixel'] as const) {
      chooseSkin(previous);
      const beforeDataset = { ...root.dataset };
      const beforeTokens = inline();
      expect(activeWorld()).toBe('standard');
      expect(root.dataset.world).toBeUndefined();
      expect(root.dataset.surface).toBeUndefined();

      expect(chooseSkin('egypt')).toBe(true);
      expect(activeWorld()).toBe('egypt');
      expect([root.dataset.theme, root.dataset.scheme, root.dataset.cut, root.dataset.world, root.dataset.surface]).toEqual([
        'egypt',
        'light',
        'bevel',
        'egypt',
        'papyrus',
      ]);
      expect(inline()[COLOR_TOKENS.bg]).toBe(builtinSkin('egypt')!.colors.bg);
      expect(root.style.getPropertyValue(WORLD_COLOR_TOKENS.ground)).toBe('#E4D1AA');
      expect(root.style.getPropertyValue(WORLD_COLOR_TOKENS.water)).toBe('#2B6E9B');
      expect(root.style.getPropertyValue('--term-bg')).toBe('#17130F');
      expect(root.style.getPropertyValue('--term-ink')).toBe('#EFE4CE');

      nextVisit();
      expect(skinsState().active).toBe('egypt');
      expect(activeWorld()).toBe('egypt');
      expect(root.dataset.world).toBe('egypt');
      expect(root.dataset.surface).toBe('papyrus');
      expect(root.style.getPropertyValue(WORLD_COLOR_TOKENS.ground)).toBe('#E4D1AA');

      expect(chooseSkin(previous)).toBe(true);
      expect(activeWorld()).toBe('standard');
      expect(root.dataset.world).toBeUndefined();
      expect(root.dataset.surface).toBeUndefined();
      for (const property of [...WORLD_PROPERTIES, ...TERMINAL_PROPERTIES]) {
        expect(root.style.getPropertyValue(property), property).toBe('');
      }
      expect({ ...root.dataset }).toEqual(beforeDataset);
      expect(inline()).toEqual(beforeTokens);
    }
  });

  it('persists the optional papyrus map grain toggle and leaves no data-grain trace on non-papyrus themes', () => {
    expect(mapGrain()).toBe(true);
    expect(root.dataset.grain).toBeUndefined();

    chooseSkin('egypt');
    expect(root.dataset.grain).toBeUndefined();
    setMapGrain(false);
    expect(mapGrain()).toBe(false);
    expect(localStorage.getItem('hh-map-grain')).toBe('off');
    expect(root.dataset.grain).toBe('off');

    nextVisit();
    expect(mapGrain()).toBe(false);
    expect(root.dataset.grain).toBe('off');

    chooseSkin('cyberpunk');
    expect(root.dataset.grain).toBeUndefined();

    chooseSkin('egypt');
    expect(root.dataset.grain).toBe('off');
    setMapGrain(true);
    expect(mapGrain()).toBe(true);
    expect(root.dataset.grain).toBeUndefined();
  });
});
