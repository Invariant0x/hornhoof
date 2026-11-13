import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { builtinSkin } from '../src/skins/registry';
import { COLOR_ROLES, type Skin } from '../src/skins/roles';
import { parseSkin, SKIN_ERROR_CODES, SKIN_FILE_LIMIT, skinText } from '../src/skins/validate';

/* A whole skin file as a person or an AI writes it from a sample: every value of a built-in skin, a name of its own. */
const SAMPLE: Skin = { ...builtinSkin('cyberpunk')!, name: 'Night shift' };
const file = (change: (raw: Record<string, unknown>) => void = () => {}) => {
  const raw = JSON.parse(skinText(SAMPLE)) as Record<string, unknown>;
  change(raw);
  return JSON.stringify(raw);
};
const colors = (raw: Record<string, unknown>) => raw.colors as Record<string, unknown>;
const fonts = (raw: Record<string, unknown>) => raw.fonts as Record<string, unknown>;
const refused = (text: string) => {
  const parsed = parseSkin(text);
  return parsed.ok ? null : parsed.error;
};

describe('a skin file', () => {
  it('is taken whole when every value is known, safe and of its form, as a copy that owns nothing of the file', () => {
    const text = file();
    const parsed = parseSkin(text);
    expect(parsed).toEqual({ ok: true, skin: { name: 'Night shift', scheme: 'dark', colors: SAMPLE.colors, fonts: SAMPLE.fonts, cut: SAMPLE.cut } });
    expect(parsed.ok && Object.keys(parsed.skin.colors)).toEqual(COLOR_ROLES);
    expect(skinText(parsed.ok ? parsed.skin : SAMPLE)).toBe(skinText(SAMPLE));
  });

  it('writes a sample with its format, version and every field, read back as the same skin', () => {
    const raw = JSON.parse(skinText(SAMPLE)) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['format', 'version', 'name', 'scheme', 'colors', 'fonts', 'cut']);
    expect(raw.format).toBe('hornhoof-skin');
    expect(raw.version).toBe(1);
    expect(skinText(SAMPLE).endsWith('}\n')).toBe(true);
  });

  it('takes the colours in #RGB, #RRGGBB, #RRGGBBAA and rgb() or rgba() and the cut from 0 to 1.5', () => {
    for (const value of ['#abc', '#abcd', '#A1B2C3', '#a1b2c3d4', 'rgb(0, 0, 0)', 'rgba(255,255,255,.5)', 'rgba(1, 2, 3, 0.25)', 'rgba(1, 2, 3, 1)']) {
      expect(refused(file(raw => (colors(raw).bg = value))), value).toBeNull();
    }
    for (const cut of [0, 0.25, 1, 1.5]) expect(refused(file(raw => (raw.cut = cut))), String(cut)).toBeNull();
    expect(refused(file(raw => (raw.scheme = 'light')))).toBeNull();
    expect(refused(file(raw => (fonts(raw).body = ['Pixelify Sans', 'Onest', '-apple-system', 'sans-serif'])))).toBeNull();
  });
});

describe('the safety check of a skin file', () => {
  it('refuses a file over the size limit before reading it', () => {
    expect(SKIN_FILE_LIMIT).toBe(16 * 1024);
    const padded = file(raw => (raw.name = 'x'));
    expect(refused(padded.padEnd(SKIN_FILE_LIMIT, ' '))).toBeNull();
    expect(refused(padded.padEnd(SKIN_FILE_LIMIT + 1, ' '))).toEqual({ code: 'too_large' });
  });

  it('refuses what is not JSON or not a Hornhoof skin', () => {
    expect(refused('{"format": ')).toEqual({ code: 'not_json' });
    expect(refused('[]')).toEqual({ code: 'not_skin' });
    expect(refused('"hornhoof-skin"')).toEqual({ code: 'not_skin' });
    expect(refused(file(raw => (raw.format = 'hornhoof-theme')))).toEqual({ code: 'not_skin' });
    expect(refused(file(raw => (raw.version = 2)))).toEqual({ code: 'not_skin' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the key %s anywhere in the file, before anything else', key => {
    const at = (path: string) => ({ code: 'forbidden_key', key: path });
    expect(refused(file().replace('{', `{"${key}": {"polluted": true},`))).toEqual(at(key));
    expect(refused(file().replace('"colors":{', `"colors":{"${key}": "#000000",`))).toEqual(at(`colors.${key}`));
    expect(refused(file().replace('"fonts":{', `"fonts":{"${key}": ["serif"],`))).toEqual(at(`fonts.${key}`));
    expect(refused(`{"${key}": 1}`)).toEqual(at(key));
    expect(refused(`{"a": [{"b": {"${key}": 1}}]}`)).toEqual(at(`a.0.b.${key}`));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['grid', 'grid'], ['spacing', 'spacing'], ['gap', 'gap'], ['padding', 'padding'], ['margin', 'margin'], ['layout', 'layout'], ['sizes', 'sizes'], ['font_size', 'font_size'], ['lineHeight', 'lineHeight'], ['radius', 'radius'], ['width', 'width'],
  ])('refuses a change of the grid, sizes or gaps: %s at the top', (key, path) => {
    expect(refused(file(raw => (raw[key] = 4)))).toEqual({ code: 'layout_locked', key: path });
  });

  it('refuses a change of the grid, sizes or gaps inside colours and fonts too, and an unknown key as unknown', () => {
    expect(refused(file(raw => (colors(raw)['--gap'] = '#000000')))).toEqual({ code: 'layout_locked', key: 'colors.--gap' });
    expect(refused(file(raw => (fonts(raw).size = ['serif'])))).toEqual({ code: 'layout_locked', key: 'fonts.size' });
    expect(refused(file(raw => (raw.base = 'matrix')))).toEqual({ code: 'unknown_key', key: 'base' });
    expect(refused(file(raw => (colors(raw).background = '#000000')))).toEqual({ code: 'unknown_key', key: 'colors.background' });
  });

  it.each([
    ['a link', 'url(https://example.com/x.png)'],
    ['a link in capitals with spaces', 'URL  (x)'],
    ['an expression', 'expression(alert(1))'],
    ['a variable', 'var(--bg)'],
    ['an image', 'image(red)'],
    ['a script link', 'javascript:alert(1)'],
    ['an import', '@import "x.css"'],
    ['a tag', '<script>alert(1)</script>'],
    ['a way out of the declaration', '#000000; background: red'],
    ['a way out of the rule', '#000000 } body {'],
    ['an escape', '\\23 000'],
    ['a comment', '#000/**/000'],
    ['a control character', '#000000\u0000'],
    ['a line break', '#000\n000'],
    ['a direction override', '#000000\u202e'],
    ['a direction isolate', '\u2066#000000'],
    ['a zero-width space', '#00\u200b0000'],
    ['a byte order mark', '\ufeff#000000'],
  ])('refuses %s in a colour as code', (_what, value) => {
    expect(refused(file(raw => (colors(raw).accent = value)))).toEqual({ code: 'unsafe', key: 'colors.accent' });
  });

  it('refuses code in a font name and in the name of the skin', () => {
    expect(refused(file(raw => (fonts(raw).body = ['url(x)', 'serif'])))).toEqual({ code: 'unsafe', key: 'fonts.body' });
    expect(refused(file(raw => (fonts(raw).mono = ['A\u202eB', 'monospace'])))).toEqual({ code: 'unsafe', key: 'fonts.mono' });
    expect(refused(file(raw => (raw.name = '<img src=x onerror=alert(1)>')))).toEqual({ code: 'unsafe', key: 'name' });
    expect(refused(file(raw => (raw.name = 'Night\u202eshift')))).toEqual({ code: 'unsafe', key: 'name' });
    expect(refused(file(raw => (raw.name = 'Night\u0007shift')))).toEqual({ code: 'unsafe', key: 'name' });
  });

  it.each(['red', 'transparent', 'currentColor', '#12345', '#1234567', '#ggg', 'rgb(256, 0, 0)', 'rgb(0, 0)', 'rgba(0, 0, 0, 2)', 'rgba(0, 0, 0, -1)', 'hsl(0, 0%, 0%)', ' #000000', '#000000 ', 7, null, ['#000000'], {}])('refuses %j as a colour', value => {
    expect(refused(file(raw => (colors(raw).ink = value)))).toEqual({ code: 'bad_color', key: 'colors.ink' });
  });

  it.each([
    ['no list', 'Onest'],
    ['an empty list', []],
    ['no common family at the end', ['Onest']],
    ['a system keyword at the end', ['Onest', '-apple-system']],
    ['seven names', ['A', 'B', 'C', 'D', 'E', 'F', 'serif']],
    ['quotes', ["'Onest'", 'serif']],
    ['a comma', ['Onest, Arial', 'serif']],
    ['letters outside Latin', ['Онест', 'serif']],
    ['a name of 41 characters', [`A${'b'.repeat(40)}`, 'serif']],
    ['a space at the edge', [' Onest', 'serif']],
    ['a number', [7, 'serif']],
  ])('refuses %s as fonts', (_what, value) => {
    expect(refused(file(raw => (fonts(raw).display = value)))).toEqual({ code: 'bad_font', key: 'fonts.display' });
  });

  it.each([-0.1, 1.51, 2, '1', null, true])('refuses %j as the cut', cut => {
    expect(refused(file(raw => (raw.cut = cut)))).toEqual({ code: 'bad_cut' });
  });

  it('refuses a scheme other than dark or light, and a name that is empty, long or not text', () => {
    for (const scheme of ['system', 'Dark', 1]) expect(refused(file(raw => (raw.scheme = scheme)))).toEqual({ code: 'bad_scheme' });
    for (const name of ['', '   ', 'x'.repeat(61), 7]) expect(refused(file(raw => (raw.name = name)))).toEqual({ code: 'bad_name' });
    expect(refused(file(raw => (raw.name = 'x'.repeat(60))))).toBeNull();
    expect(refused(file(raw => (raw.name = 'Ночная смена: 2 (beta) & Co!')))).toBeNull();
  });

  it('asks for every field of a self-contained skin and names the first one missing', () => {
    for (const key of ['name', 'scheme', 'colors', 'fonts', 'cut']) expect(refused(file(raw => delete raw[key])), key).toEqual({ code: 'missing', key });
    expect(refused(file(raw => delete colors(raw).shadow))).toEqual({ code: 'missing', key: 'colors.shadow' });
    expect(refused(file(raw => delete fonts(raw).mono))).toEqual({ code: 'missing', key: 'fonts.mono' });
    expect(refused(file(raw => (raw.colors = ['#000000'])))).toEqual({ code: 'not_object', key: 'colors' });
    expect(refused(file(raw => (raw.fonts = 'serif')))).toEqual({ code: 'not_object', key: 'fonts' });
  });

  it('says what is wrong in plain words in English and Russian for every refusal', () => {
    for (const code of SKIN_ERROR_CODES) {
      for (const words of [en, ru]) {
        const text = words.skins.errors[code]('colors.bg');
        expect(text, code).toMatch(/\S/);
        expect(text, code).not.toMatch(/[\u2014\u0451\u0401]/);
      }
    }
    expect(en.skins.errors.unsafe('colors.bg')).toContain('colors.bg');
    expect(ru.skins.errors.layout_locked('grid')).toContain('grid');
  });
});
