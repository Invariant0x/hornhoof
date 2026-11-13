import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS, builtinSkin, DEFAULT_SKIN } from '../src/skins/registry';
import { COLOR_ROLES, COLOR_TOKENS, CUT_TOKEN, declarations, FONT_ROLES, FONT_TOKENS, SKIN_PROPERTIES, type SkinLook } from '../src/skins/roles';
import { parseSkin, skinText } from '../src/skins/validate';
import { RULES } from './css';

/* WCAG 2 contrast of two colours of a skin; rgba() is read without its alpha, as the sheet of a theme counts it. */
const channels = (color: string) => (color.startsWith('#') ? [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)) : color.match(/\d+/g)!.slice(0, 3).map(Number));
const luminance = (color: string) => channels(color).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};
const SURFACES = ['bg', 'surface', 'surface2'] as const;
const TEXT = ['ink', 'muted', 'accent_ink', 'warning_ink', 'attention_ink', 'success', 'danger', 'provider_claude', 'provider_kimi', 'provider_glm', 'provider_antigravity'] as const;

describe('the registry of built-in skins', () => {
  it('holds Cyberpunk, Light, Matrix, Pixel and Neon in this order, Cyberpunk first and on by default', () => {
    expect(BUILTIN_SKINS.map(skin => skin.id)).toEqual(['cyberpunk', 'light', 'matrix', 'pixel', 'neon']);
    expect(DEFAULT_SKIN).toBe('cyberpunk');
    expect(builtinSkin('cyberpunk')).toBe(BUILTIN_SKINS[0]);
    expect(builtinSkin('dark')).toBeUndefined();
    expect(builtinSkin('__proto__')).toBeUndefined();
  });

  it('gives each skin its own mark of dark or light, and Light alone is light', () => {
    expect(Object.fromEntries(BUILTIN_SKINS.map(skin => [skin.id, skin.scheme]))).toEqual({ cyberpunk: 'dark', light: 'light', matrix: 'dark', pixel: 'dark', neon: 'dark' });
  });

  it('cuts corners in Cyberpunk and Light, keeps Matrix and Pixel square', () => {
    expect(Object.fromEntries(BUILTIN_SKINS.map(skin => [skin.id, skin.cut]))).toEqual({ cyberpunk: 1, light: 1, matrix: 0, pixel: 0, neon: 1 });
  });

  it('writes Pixel in its own pixel font with a common family behind it, and the others in the shared fonts', () => {
    const pixel = builtinSkin('pixel')!;
    expect(pixel.fonts.display[0]).toBe('Pixelify Sans');
    expect(pixel.fonts.body[0]).toBe('Pixelify Sans');
    for (const skin of BUILTIN_SKINS.filter(skin => skin.id !== 'pixel')) expect(skin.fonts.body[0], skin.id).toBe('Onest');
  });

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s fills every one of the 27 colour roles and passes the same check as a file', (_id, skin) => {
    expect(COLOR_ROLES).toHaveLength(27);
    expect(Object.keys(skin.colors).sort()).toEqual([...COLOR_ROLES].sort());
    expect(Object.keys(skin.fonts).sort()).toEqual([...FONT_ROLES].sort());
    const parsed = parseSkin(skinText({ ...skin, name: 'Sample' }));
    expect(parsed.ok && parsed.skin).toEqual({ name: 'Sample', scheme: skin.scheme, colors: skin.colors, fonts: skin.fonts, cut: skin.cut });
  });

  it.each(BUILTIN_SKINS.map(skin => [skin.id, skin] as const))('%s keeps text readable: 4.5:1 for text on every surface and on its fills, 3:1 for control lines', (_id, { colors }) => {
    for (const surface of SURFACES) {
      for (const text of TEXT) expect(contrast(colors[text], colors[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.line2, colors[surface]), `line2 on ${surface}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(colors.on_button, colors.button)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.on_danger, colors.danger)).toBeGreaterThanOrEqual(4.5);
  });

  it('names every built-in skin in English and Russian', () => {
    for (const { id } of BUILTIN_SKINS) {
      expect(en.skins.names[id], id).toMatch(/\S/);
      expect(ru.skins.names[id], id).toMatch(/\S/);
    }
    expect(Object.values(ru.skins.names)).toEqual(['Киберпанк', 'Светлая', 'Матрица', 'Пиксельная', 'Неон']);
    expect(Object.values(en.skins.names)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Neon']);
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

  it('turns a skin into the tokens of the page: every colour, the three font stacks, the cut and how the browser draws its own parts', () => {
    const base = builtinSkin('light')!;
    const look: SkinLook = { ...base, fonts: { display: ['Pixelify Sans', 'monospace'], body: ['Pixel Body', '-apple-system', 'system-ui', 'sans-serif'], mono: ['ui-monospace', 'monospace'] }, cut: 0.5 };
    const set = Object.fromEntries(declarations(look));
    expect(Object.keys(set).sort()).toEqual([...SKIN_PROPERTIES].sort());
    for (const role of COLOR_ROLES) expect(set[COLOR_TOKENS[role]], role).toBe(base.colors[role]);
    expect(set[FONT_TOKENS.display]).toBe("'Pixelify Sans', monospace");
    expect(set[FONT_TOKENS.body]).toBe("'Pixel Body', -apple-system, system-ui, sans-serif");
    expect(set[FONT_TOKENS.mono]).toBe('ui-monospace, monospace');
    expect(set[CUT_TOKEN]).toBe('0.5');
    expect(set['color-scheme']).toBe('light');
  });
});
