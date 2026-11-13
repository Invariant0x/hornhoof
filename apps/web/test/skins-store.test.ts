import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLLECTION_LIMIT, collectionText, readCollection, withAdded, without } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS, CUT_TOKEN, FONT_TOKENS, lookOnly, SKIN_PROPERTIES, type Skin } from '../src/skins/roles';
import { chooseSkin, forgetSkin, initSkins, keepSkins, lookOf, skinsState, subscribeSkins } from '../src/skins/store';
import { skinText } from '../src/skins/validate';

const root = document.documentElement;
const MATRIX = lookOnly(builtinSkin('matrix')!);
const skin = (name: string, bg = '#010203'): Skin => ({ ...MATRIX, name, colors: { ...MATRIX.colors, bg } });
const inline = () => Object.fromEntries(SKIN_PROPERTIES.map(property => [property, root.style.getPropertyValue(property)]).filter(([, value]) => value));

function clearPage() {
  delete root.dataset.theme;
  delete root.dataset.scheme;
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
  it('adds skins after the ones kept, each under a number of its own, even when names repeat', () => {
    const first = withAdded([], [skin('Dusk'), skin('Dusk', '#020304')]);
    expect(first.added.map(entry => entry.id)).toEqual(['custom-1', 'custom-2']);
    const second = withAdded(first.list, [skin('Dawn')]);
    expect(second.list.map(entry => [entry.id, entry.skin.name])).toEqual([['custom-1', 'Dusk'], ['custom-2', 'Dusk'], ['custom-3', 'Dawn']]);
    expect(second.over).toBe(0);
  });

  it('gives a new skin a number above every one kept, so a deleted number is never mixed up with a new skin', () => {
    const list = withAdded([], [skin('A'), skin('B'), skin('C')]).list;
    expect(withAdded(without(list, 'custom-2'), [skin('D')]).added[0]!.id).toBe('custom-4');
  });

  it(`holds at most ${COLLECTION_LIMIT} skins and counts those left out`, () => {
    const many = Array.from({ length: COLLECTION_LIMIT + 2 }, (_, i) => skin(`S${i}`));
    const result = withAdded([], many);
    expect(result.list).toHaveLength(COLLECTION_LIMIT);
    expect(result.over).toBe(2);
    expect(withAdded(result.list, [skin('More')])).toEqual({ list: result.list, added: [], over: 1 });
  });

  it('reads back what it wrote, and drops a broken, unsafe, repeated or foreign entry instead of trusting it', () => {
    const list = withAdded([], [skin('Dusk'), skin('Dawn')]).list;
    expect(readCollection(collectionText(list))).toEqual(list);
    const unsafe = { id: 'custom-7', skin: { ...JSON.parse(skinText(skin('Bad'))), colors: { ...skin('Bad').colors, bg: 'url(x)' } } };
    const text = JSON.stringify([...JSON.parse(collectionText(list)), unsafe, { id: 'custom-1', skin: JSON.parse(skinText(skin('Again'))) }, { id: 'cyberpunk', skin: JSON.parse(skinText(skin('Fake'))) }, { id: '__proto__', skin: {} }, 'x', null]);
    expect(readCollection(text)).toEqual(list);
    for (const broken of [null, '', 'not json', '{}', '"x"', '[[]]']) expect(readCollection(broken), String(broken)).toEqual([]);
  });
});

describe('the skin on the page', () => {
  it('starts in Cyberpunk, dark, before a person picks anything, whatever the system prefers', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: light)' }));
    nextVisit();
    expect(skinsState().active).toBe('cyberpunk');
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(root.dataset.scheme).toBe('dark');
    expect(inline()[COLOR_TOKENS.bg]).toBe(builtinSkin('cyberpunk')!.colors.bg);
    expect(inline()['color-scheme']).toBe('dark');
    vi.unstubAllGlobals();
  });

  it.each(BUILTIN_SKINS.map(entry => entry.id))('switches to %s at once, sets all its tokens and keeps it for the next visit', id => {
    expect(chooseSkin(id)).toBe(true);
    const look = builtinSkin(id)!;
    expect(root.dataset.theme).toBe(id);
    expect(root.dataset.scheme).toBe(look.scheme);
    expect(Object.keys(inline()).sort()).toEqual([...SKIN_PROPERTIES].sort());
    expect(inline()[COLOR_TOKENS.surface]).toBe(look.colors.surface);
    expect(inline()[CUT_TOKEN]).toBe(String(look.cut));
    expect(localStorage.getItem('hh-theme')).toBe(id);
    nextVisit();
    expect(skinsState().active).toBe(id);
    expect(root.dataset.theme).toBe(id);
  });

  it('takes a name it does not know, from an older version or a deleted skin, as Cyberpunk', () => {
    for (const saved of ['dark', 'custom', 'custom-9', '__proto__', 'constructor', '']) {
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

  it('keeps several loaded skins without turning one on, and puts a chosen one on the page in full', () => {
    chooseSkin('light');
    const kept = keepSkins([skin('Dusk'), skin('Dawn', '#0A0B0C')]);
    expect(kept).toEqual({ added: [{ id: 'custom-1', skin: skin('Dusk') }, { id: 'custom-2', skin: skin('Dawn', '#0A0B0C') }], over: 0, kept: true });
    expect(skinsState().active).toBe('light');
    expect(root.dataset.theme).toBe('light');
    keepSkins([skin('Noon')]);
    expect(skinsState().custom.map(entry => entry.skin.name)).toEqual(['Dusk', 'Dawn', 'Noon']);
    chooseSkin('custom-2');
    expect(root.dataset.theme).toBe('custom-2');
    expect(root.dataset.scheme).toBe('dark');
    expect(inline()[COLOR_TOKENS.bg]).toBe('#0A0B0C');
    expect(inline()[FONT_TOKENS.display]).toBe("'Tektur', 'Onest', system-ui, sans-serif");
    nextVisit();
    expect(skinsState()).toEqual({ active: 'custom-2', custom: [{ id: 'custom-1', skin: skin('Dusk') }, { id: 'custom-2', skin: skin('Dawn', '#0A0B0C') }, { id: 'custom-3', skin: skin('Noon') }] });
    expect(inline()[COLOR_TOKENS.bg]).toBe('#0A0B0C');
  });

  it('deletes a skin of the collection; deleting the one that is on turns Cyberpunk on', () => {
    keepSkins([skin('Dusk'), skin('Dawn')]);
    chooseSkin('custom-1');
    forgetSkin('custom-2');
    expect(skinsState()).toEqual({ active: 'custom-1', custom: [{ id: 'custom-1', skin: skin('Dusk') }] });
    forgetSkin('custom-1');
    expect(skinsState()).toEqual({ active: 'cyberpunk', custom: [] });
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(localStorage.getItem('hh-theme')).toBe('cyberpunk');
    nextVisit();
    expect(skinsState()).toEqual({ active: 'cyberpunk', custom: [] });
  });

  it('never deletes a built-in skin', () => {
    chooseSkin('pixel');
    forgetSkin('pixel');
    expect(skinsState().active).toBe('pixel');
    expect(lookOf('pixel')).toBe(builtinSkin('pixel'));
  });

  it('gives the look of any skin by its name, and nothing for one that is not there', () => {
    keepSkins([skin('Dusk')]);
    expect(lookOf('custom-1')).toEqual(skin('Dusk'));
    expect(lookOf('custom-2')).toBeNull();
    expect(lookOf('hasOwnProperty')).toBeNull();
  });

  it('says when the browser could not keep the collection, and still uses it for this visit', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(keepSkins([skin('Dusk')]).kept).toBe(false);
    expect(chooseSkin('custom-1')).toBe(true);
    expect(root.dataset.theme).toBe('custom-1');
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
    keepSkins([skin('Dusk')]);
    forgetSkin('custom-1');
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    chooseSkin('light');
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
