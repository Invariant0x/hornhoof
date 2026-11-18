import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { contrast, CONTRAST_PAIRS, readColor, weakPair } from '../src/skins/contrast';
import { BUILTIN_SKINS, builtinSkin, DEFAULT_SKIN, ownLook, SHIPPED_FONTS } from '../src/skins/registry';
import { COLOR_ROLES, COLOR_TOKENS, CUT_TOKEN, declarations, FONT_ROLES, FONT_TOKENS, SKIN_PROPERTIES, type SkinLook } from '../src/skins/roles';
import { builtinFile, FILE_FONTS, parseSkin, skinText } from '../src/skins/validate';
import { RULES } from './css';

const ratio = (a: string, b: string) => contrast(readColor(a)!, readColor(b)!);
const NAMES = { ru: 'Образец', en: 'Sample' };

describe('the registry of built-in skins', () => {
  it('holds Cyberpunk, Light, Matrix and Pixel in this order, Cyberpunk first and on by default, and no Neon', () => {
    expect(BUILTIN_SKINS.map(skin => skin.id)).toEqual(['cyberpunk', 'light', 'matrix', 'pixel']);
    expect(DEFAULT_SKIN).toBe('cyberpunk');
    expect(builtinSkin('cyberpunk')).toBe(BUILTIN_SKINS[0]);
    for (const gone of ['neon', 'dark', '__proto__', 'constructor']) expect(builtinSkin(gone), gone).toBeUndefined();
  });

  it('gives each skin its own mark of dark or light, and Light alone is light', () => {
    expect(Object.fromEntries(BUILTIN_SKINS.map(skin => [skin.id, skin.scheme]))).toEqual({ cyberpunk: 'dark', light: 'light', matrix: 'dark', pixel: 'dark' });
  });

  it('slants the corners of Cyberpunk and Light, keeps Matrix square and cuts Pixel in two steps', () => {
    expect(Object.fromEntries(BUILTIN_SKINS.map(skin => [skin.id, [skin.shape, skin.cut]]))).toEqual({
      cyberpunk: ['bevel', 1],
      light: ['bevel', 1],
      matrix: ['bevel', 0],
      pixel: ['steps', 1],
    });
  });

  it('writes Pixel headings and buttons in Handjet and its text in Onest; the others in Tektur and Onest', () => {
    const pixel = builtinSkin('pixel')!;
    expect(pixel.fonts.display).toEqual(['Handjet', 'Onest', 'system-ui', 'sans-serif']);
    for (const skin of BUILTIN_SKINS) {
      expect(skin.fonts.body[0], skin.id).toBe('Onest');
      expect(skin.fonts.mono[0], skin.id).toBe('ui-monospace');
      if (skin.id !== 'pixel') expect(skin.fonts.display[0], skin.id).toBe('Tektur');
    }
    expect(SHIPPED_FONTS).toEqual(['Onest', 'Tektur', 'Handjet']);
  });

  it('takes the warm Pixel sheet of Design whole, with the new on_attention of Cyberpunk and Light', () => {
    const { colors } = builtinSkin('pixel')!;
    expect([colors.bg, colors.surface, colors.ink, colors.accent, colors.button, colors.on_button, colors.attention, colors.on_attention]).toEqual([
      '#151523', '#202033', '#FFF4DA', '#FFD166', '#FFD166', '#252018', '#E99EFF', '#26172C',
    ]);
    expect([colors.scrim, colors.scrollbar_thumb, colors.scrollbar_track]).toEqual(['rgba(8, 8, 18, .64)', '#9292AD', '#202033']);
    expect(builtinSkin('cyberpunk')!.colors.on_attention).toBe('#141A22');
    expect(builtinSkin('light')!.colors.on_attention).toBe('#000000');
    expect(builtinSkin('cyberpunk')!.colors.line2).toBe('#687A8F');
  });

  it('keeps the glass of every built-in skin dense, as Design set it for glass with no blur under it', () => {
    expect(BUILTIN_SKINS.map(skin => [skin.id, skin.colors.hud])).toEqual([
      ['cyberpunk', 'rgba(23, 30, 39, .94)'],
      ['light', 'rgba(240, 244, 247, .94)'],
      ['matrix', 'rgba(8, 16, 11, .94)'],
      ['pixel', 'rgba(26, 26, 43, .94)'],
    ]);
  });

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s fills all 31 colour roles and, given out as a file, passes the same check', (_id, skin) => {
    expect(COLOR_ROLES).toHaveLength(31);
    expect(Object.keys(skin.colors).sort()).toEqual([...COLOR_ROLES].sort());
    expect(Object.keys(skin.fonts).sort()).toEqual([...FONT_ROLES].sort());
    const file = builtinFile(skin, NAMES);
    expect(parseSkin(skinText(file))).toEqual({ ok: true, skin: file });
    expect(file.base).toBe(skin.id);
    for (const role of FONT_ROLES) expect(file.fonts[role].every(font => FILE_FONTS[role].includes(font)), role).toBe(true);
    expect(ownLook(file)).toEqual({ scheme: skin.scheme, colors: skin.colors, fonts: file.fonts, cut: skin.cut, shape: skin.shape });
  });

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s keeps text readable: 4.5:1 for text on every surface and on its fills, 3:1 for control lines', (_id, { colors }) => {
    expect(weakPair(colors)).toBeNull();
    for (const surface of ['bg', 'surface', 'surface2'] as const) {
      expect(ratio(colors.ink, colors[surface]), `ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors.line2, colors[surface]), `line2 on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(colors.on_attention, colors.attention)).toBeGreaterThanOrEqual(4.5);
  });

  it('names and describes every built-in skin in English and Russian', () => {
    for (const { id } of BUILTIN_SKINS) {
      for (const words of [en, ru]) {
        expect(words.skins.names[id], id).toMatch(/\S/);
        expect(words.skins.descs[id], id).toMatch(/\S/);
      }
    }
    expect(Object.values(ru.skins.names)).toEqual(['Киберпанк', 'Светлая', 'Матрица', 'Пиксельная']);
    expect(Object.values(en.skins.names)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel']);
  });
});

describe('the contrast a skin must hold', () => {
  it('counts WCAG 2 contrast exactly, from #RRGGBB and from rgba()', () => {
    expect(ratio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(ratio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(ratio('rgba(0, 0, 0, 1)', '#777777')).toBeCloseTo(ratio('#000000', '#777777'), 10);
    expect(readColor('rgba(1, 2, 3, .5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    for (const bad of ['#FFF', '#FFFFFFFF', 'rgb(0, 0, 0)', 'rgba(256, 0, 0, 1)', 'rgba(0, 0, 0, 2)', 'red']) expect(readColor(bad), bad).toBeNull();
  });

  it('checks text on the three surfaces, the three fills and the borders of controls, and names the first pair that fails', () => {
    expect(CONTRAST_PAIRS).toHaveLength(11 * 3 + 3 + 3);
    const light = builtinSkin('light')!.colors;
    expect(weakPair({ ...light, muted: '#AAAAAA' })).toEqual({ text: 'muted', on: 'bg', least: 4.5, kind: 'text' });
    expect(weakPair({ ...light, on_attention: '#FFFFFF' })).toEqual({ text: 'on_attention', on: 'attention', least: 4.5, kind: 'text' });
    expect(weakPair({ ...light, line2: '#C0C8D0' })).toEqual({ text: 'line2', on: 'bg', least: 3, kind: 'line' });
    expect(weakPair({ ...light, ink: 'url(x)' })).toMatchObject({ text: 'ink' });
  });

  it('holds the bars exactly: 4.44 is under 4.5 for text and 2.99 under 3 for a border, 4.51 and 3.04 pass', () => {
    const light = builtinSkin('light')!.colors;
    expect(ratio('#6B6B6B', light.bg)).toBeCloseTo(4.44, 2);
    expect(weakPair({ ...light, muted: '#6B6B6B' })).toMatchObject({ text: 'muted', on: 'bg', kind: 'text' });
    /* 4.51 holds on bg; the first pair it fails is muted on the glass over a black page, which Design holds at 4.5 too. */
    expect(weakPair({ ...light, muted: '#6A6A6A' })).toEqual({ text: 'muted', on: 'hud', least: 4.5, kind: 'text' });
    expect(ratio('#878787', light.bg)).toBeCloseTo(2.99, 2);
    expect(weakPair({ ...light, line2: '#878787' })).toMatchObject({ text: 'line2', on: 'bg', kind: 'line' });
    expect(weakPair({ ...light, line2: '#868686' })).toBeNull();
  });
});

describe('one source for the values of a skin', () => {
  it('keeps no colour, font or cut of a skin in theme.css and no light or dark mode of the system', () => {
    const declared = RULES.flatMap(rule => Object.entries(rule.decls).map(([property, value]) => ({ property, value, where: rule.selectors.join(', ') })));
    const skinTokens: string[] = [...Object.values(COLOR_TOKENS), ...Object.values(FONT_TOKENS), CUT_TOKEN];
    /* A component may point a token at another one, as a busy department's glow takes the accent; a value is the skin's. */
    expect(declared.filter(({ property, value }) => skinTokens.includes(property) && !/^var\(--[a-z0-9-]+\)$/.test(value))).toEqual([]);
    expect(RULES.filter(rule => rule.media?.includes('prefers-color-scheme'))).toEqual([]);
    expect(RULES.filter(rule => rule.selectors.some(selector => selector.includes('data-theme')))).toEqual([]);
  });

  it('draws the scrim, the text on attention and the scrollbars from the skin, not from fixed colours', () => {
    const value = (selector: string, property: string) => RULES.find(rule => rule.selectors.includes(selector) && rule.decls[property])?.decls[property];
    expect(value('.dialog-back', 'background')).toBe('var(--scrim)');
    expect(value('.nav-count', 'color')).toBe('var(--on-pink)');
    expect(value('html', 'scrollbar-color')).toBe('var(--scrollbar-thumb) var(--scrollbar-track)');
  });

  it('cuts the parts of a stepped skin in steps, and leaves ghost and focused buttons square', () => {
    const stepped = RULES.filter(rule => rule.selectors.some(selector => selector.includes("[data-cut='steps']")));
    expect(stepped.flatMap(rule => rule.selectors)).toEqual([
      ":where(:root[data-cut='steps']) .tr-dept-mark",
      ":where(:root[data-cut='steps']) .tr-status-pill",
      ":where(:root[data-cut='steps']) .edge",
      ":where(:root[data-cut='steps']) .btn",
      ":where(:root[data-cut='steps']) .tview .lchip",
      ":where(:root[data-cut='steps']) .tview .tv-card-edge",
      ":where(:root[data-cut='steps']) .halo-glow > i",
      ".skin-preview[data-cut='steps'] .sp-btn",
      ":where(:root[data-cut='steps']) .halo-ring",
    ]);
    expect(stepped[0]!.decls['clip-path']).toContain('calc(100% - 2 * var(--step)) var(--step)');
    /* The focus ring of a framed button steps on both of its edges, its steps as big as the frame's. */
    const ring = stepped.at(-1)!.decls;
    expect(ring['--step']).toBe(stepped[0]!.decls['--step']);
    expect(ring['clip-path']).toMatch(/^polygon\(evenodd, /);
    expect(ring['clip-path']).toContain('calc(100% - var(--ring) - var(--s2)) var(--ring)');
    const last = (selector: string) => RULES.filter(rule => rule.selectors.includes(selector) && rule.decls['clip-path']).at(-1)?.decls['clip-path'];
    expect(last('.btn.ghost')).toBe('none');
    expect(last('.btn:focus-visible')).toBe('none');
  });

  it('turns a skin into the tokens of the page: every colour, the three font stacks, the cut and how the browser draws its own parts', () => {
    const base = builtinSkin('light')!;
    const look: SkinLook = { ...base, fonts: { display: ['Handjet', 'monospace'], body: ['Pixel Body', '-apple-system', 'system-ui', 'sans-serif'], mono: ['ui-monospace', 'monospace'] }, cut: 0.5 };
    const set = Object.fromEntries(declarations(look));
    expect(Object.keys(set).sort()).toEqual([...SKIN_PROPERTIES].sort());
    for (const role of COLOR_ROLES) expect(set[COLOR_TOKENS[role]], role).toBe(base.colors[role]);
    expect(set[FONT_TOKENS.display]).toBe("'Handjet', monospace");
    expect(set[FONT_TOKENS.body]).toBe("'Pixel Body', -apple-system, system-ui, sans-serif");
    expect(set[FONT_TOKENS.mono]).toBe('ui-monospace, monospace');
    expect(set[CUT_TOKEN]).toBe('0.5');
    expect(set['color-scheme']).toBe('light');
  });
});
