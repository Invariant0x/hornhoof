import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { builtinSkin } from '../src/skins/registry';
import { COLOR_ROLES, type Skin } from '../src/skins/roles';
import { builtinFile, parseSkin, SEE_THROUGH, SKIN_ERROR_CODES, SKIN_FILE_LIMIT, skinText } from '../src/skins/validate';

/* A whole skin file as a person or an AI writes it from a sample: every value of a built-in skin, names of its own. */
const SAMPLE: Skin = builtinFile(builtinSkin('pixel')!, { ru: 'Ночная смена', en: 'Night shift' });
type Raw = Record<string, unknown>;
const file = (change: (raw: Raw) => void = () => {}) => {
  const raw = JSON.parse(skinText(SAMPLE)) as Raw;
  change(raw);
  return JSON.stringify(raw);
};
const colors = (raw: Raw) => raw.colors as Raw;
const fonts = (raw: Raw) => raw.fonts as Raw;
const names = (raw: Raw) => raw.name as Raw;
const refused = (text: string) => {
  const parsed = parseSkin(text);
  return parsed.ok ? null : parsed.error;
};

describe('a skin file of version 2', () => {
  it('is taken whole when every value is known, safe, of its form and readable, as a copy that owns nothing of the file', () => {
    const parsed = parseSkin(file());
    expect(parsed).toEqual({ ok: true, skin: SAMPLE });
    expect(parsed.ok && Object.keys(parsed.skin.colors)).toEqual(COLOR_ROLES);
    expect(parsed.ok && parsed.skin.colors).not.toBe(SAMPLE.colors);
  });

  it('is the sample of Design: version, base, names in Russian and English, color_scheme, 31 colours, fonts and cut', () => {
    const raw = JSON.parse(skinText(SAMPLE)) as Raw;
    expect(Object.keys(raw)).toEqual(['schema_version', 'base', 'name', 'color_scheme', 'colors', 'fonts', 'cut']);
    expect(raw).toMatchObject({ schema_version: 2, base: 'pixel', name: { ru: 'Ночная смена', en: 'Night shift' }, color_scheme: 'dark', cut: 1 });
    expect(Object.keys(colors(raw))).toHaveLength(31);
    expect(fonts(raw)).toEqual({ display: ['Handjet', 'Onest', 'system-ui', 'sans-serif'], body: ['Onest', 'system-ui', 'sans-serif'], mono: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'] });
    expect(skinText(SAMPLE).endsWith('}\n')).toBe(true);
  });

  it('takes a valid custom pixel skin file as it is', () => {
    const example = {
      schema_version: 2, base: 'pixel', name: { ru: 'Моя пиксельная тема', en: 'My pixel theme' }, color_scheme: 'dark', colors: { ...SAMPLE.colors },
      fonts: { display: ['Handjet', 'Onest', 'sans-serif'], body: ['Onest', 'sans-serif'], mono: ['ui-monospace', 'monospace'] }, cut: 1,
    };
    expect(parseSkin(JSON.stringify(example))).toMatchObject({ ok: true, skin: { base: 'pixel', name: example.name } });
  });

  it('takes colours as #RRGGBB or rgba(), see-through only where Design allows it, and the cut from 0 to 1.5', () => {
    for (const value of ['#ffffff', '#FFF4DA', 'rgba(255,244,218,1)', 'rgba(255, 244, 218, 1.0)']) expect(refused(file(raw => (colors(raw).ink = value))), value).toBeNull();
    /* Glass as thin as a quarter would fade muted text over a white page, so it is see-through as densely as Design sets it. */
    for (const role of SEE_THROUGH) expect(refused(file(raw => (colors(raw)[role] = role === 'hud' ? 'rgba(0, 0, 0, .94)' : 'rgba(0, 0, 0, .25)'))), role).toBeNull();
    expect(SEE_THROUGH).toEqual(['dot', 'glow', 'hud', 'shadow', 'scrim']);
    /* A font list holds at most six names from its role's allowed set. */
    expect(refused(file(raw => (fonts(raw).display = ['Tektur', 'Handjet', 'Alegreya', 'Onest', 'system-ui', 'sans-serif', 'serif'])))).toEqual({ code: 'font_list', key: 'fonts.display' });
    for (const cut of [0, 0.25, 1, 1.5]) expect(refused(file(raw => (raw.cut = cut))), String(cut)).toBeNull();
    for (const base of ['cyberpunk', 'light', 'matrix', 'pixel', 'egypt']) expect(refused(file(raw => (raw.base = base))), base).toBeNull();
    expect(refused(file(raw => (fonts(raw).display = ['Alegreya', 'serif'])))).toBeNull();
    expect(refused(file(raw => (fonts(raw).body = ['Golos Text', 'sans-serif'])))).toBeNull();
  });
});

describe('the safety check of a skin file', () => {
  it('refuses a file over 64 KB before reading it, counted in bytes', () => {
    expect(SKIN_FILE_LIMIT).toBe(64 * 1024);
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const padded = (size: number) => file() + ' '.repeat(size - bytes(file()));
    expect(refused(padded(SKIN_FILE_LIMIT))).toBeNull();
    expect(refused(padded(SKIN_FILE_LIMIT + 1))).toEqual({ code: 'too_large' });
    /* One letter of two bytes over the limit, in fewer characters than the limit. */
    const cyrillic = `${padded(SKIN_FILE_LIMIT - 1)}\u044f`;
    expect(cyrillic.length).toBeLessThan(SKIN_FILE_LIMIT);
    expect(refused(cyrillic)).toEqual({ code: 'too_large' });
  });

  it('refuses what is not JSON, not a skin, or a skin of another version', () => {
    expect(refused('{"schema_version": ')).toEqual({ code: 'not_json' });
    expect(refused('[]')).toEqual({ code: 'not_skin' });
    expect(refused('"skin"')).toEqual({ code: 'not_skin' });
    expect(refused(file(raw => delete raw.schema_version))).toEqual({ code: 'not_skin' });
    for (const version of [1, 3, '2']) expect(refused(file(raw => (raw.schema_version = version))), String(version)).toEqual({ code: 'bad_version', key: 'schema_version' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the key %s anywhere in the file, before anything else', key => {
    const at = (path: string) => ({ code: 'forbidden_key', key: path });
    expect(refused(file().replace('{', `{"${key}": {"polluted": true},`))).toEqual(at(key));
    expect(refused(file().replace('"colors":{', `"colors":{"${key}": "#000000",`))).toEqual(at(`colors.${key}`));
    expect(refused(file().replace('"name":{', `"name":{"${key}": "x",`))).toEqual(at(`name.${key}`));
    expect(refused(`{"${key}": 1}`)).toEqual(at(key));
    expect(refused(`{"a": [{"b": {"${key}": 1}}]}`)).toEqual(at(`a.0.b.${key}`));
    expect(({} as Raw).polluted).toBeUndefined();
  });

  it.each(['grid', 'spacing', 'gap', 'padding', 'margin', 'layout', 'sizes', 'font_size', 'lineHeight', 'radius', 'width'])('refuses a change of the grid, sizes or gaps: %s at the top', key => {
    expect(refused(file(raw => (raw[key] = 4)))).toEqual({ code: 'layout_locked', key });
  });

  it('refuses a change of the layout inside a group too, and an unknown key as unknown', () => {
    expect(refused(file(raw => (colors(raw)['--gap'] = '#000000')))).toEqual({ code: 'layout_locked', key: 'colors.--gap' });
    expect(refused(file(raw => (fonts(raw).size = ['serif'])))).toEqual({ code: 'layout_locked', key: 'fonts.size' });
    expect(refused(file(raw => (raw.decor = 'none')))).toEqual({ code: 'unknown_key', key: 'decor' });
    expect(refused(file(raw => (colors(raw).background = '#000000')))).toEqual({ code: 'unknown_key', key: 'colors.background' });
    expect(refused(file(raw => (names(raw).de = 'Nachtschicht')))).toEqual({ code: 'unknown_key', key: 'name.de' });
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

  it('refuses code in a font name and in a name of the skin', () => {
    expect(refused(file(raw => (fonts(raw).body = ['url(x)', 'sans-serif'])))).toEqual({ code: 'unsafe', key: 'fonts.body' });
    expect(refused(file(raw => (fonts(raw).mono = ['A\u202eB', 'monospace'])))).toEqual({ code: 'unsafe', key: 'fonts.mono' });
    expect(refused(file(raw => (names(raw).en = '<img src=x onerror=alert(1)>')))).toEqual({ code: 'unsafe', key: 'name.en' });
    expect(refused(file(raw => (names(raw).ru = 'Ночная\u202eсмена')))).toEqual({ code: 'unsafe', key: 'name.ru' });
    expect(refused(file(raw => (names(raw).en = 'Night\u0007shift')))).toEqual({ code: 'unsafe', key: 'name.en' });
  });

  it.each(['red', 'transparent', 'currentColor', '#FFF', '#FFF4DAFF', '#12345', '#ggg', 'rgb(0, 0, 0)', 'rgba(256, 0, 0, 1)', 'rgba(0, 0)', 'rgba(0, 0, 0, 2)', 'rgba(0, 0, 0, -1)', 'hsl(0, 0%, 0%)', ' #000000', '#000000 ', 7, null, ['#000000'], {}])(
    'refuses %j as a colour',
    value => {
      expect(refused(file(raw => (colors(raw).ink = value)))).toEqual({ code: 'bad_color', key: 'colors.ink' });
    },
  );

  it('refuses a see-through colour for text, a line or a surface', () => {
    for (const role of ['ink', 'line2', 'surface', 'button', 'on_attention', 'scrollbar_thumb']) {
      expect(refused(file(raw => (colors(raw)[role] = 'rgba(255, 244, 218, .9)'))), role).toEqual({ code: 'opaque', key: `colors.${role}` });
    }
  });

  it.each([
    ['a font Hornhoof does not carry', 'display', ['Comic Sans MS', 'sans-serif'], { code: 'bad_font', key: 'fonts.display', value: 'Comic Sans MS' }],
    ['a display font as body text', 'body', ['Handjet', 'sans-serif'], { code: 'bad_font', key: 'fonts.body', value: 'Handjet' }],
    ['a system font of the built-in list', 'body', ['Onest', 'Segoe UI', 'sans-serif'], { code: 'bad_font', key: 'fonts.body', value: 'Segoe UI' }],
    ['a number', 'mono', [7, 'monospace'], { code: 'bad_font', key: 'fonts.mono', value: '7' }],
    ['no list', 'display', 'Onest', { code: 'font_list', key: 'fonts.display' }],
    ['an empty list', 'display', [], { code: 'font_list', key: 'fonts.display' }],
    ['no common family at the end', 'display', ['Tektur', 'Onest'], { code: 'font_list', key: 'fonts.display' }],
    ['a repeat', 'display', ['Onest', 'Onest', 'sans-serif'], { code: 'font_list', key: 'fonts.display' }],
    ['seven names, which can only be with repeats', 'display', ['Tektur', 'Handjet', 'Onest', 'system-ui', 'Tektur', 'Onest', 'sans-serif'], { code: 'font_list', key: 'fonts.display' }],
  ])('refuses %s as fonts', (_what, role, value, error) => {
    expect(refused(file(raw => (fonts(raw)[role] = value)))).toEqual(error);
  });

  it.each([-0.1, 1.51, 2, '1', null, true])('refuses %j as the cut', cut => {
    expect(refused(file(raw => (raw.cut = cut)))).toEqual({ code: 'bad_cut', key: 'cut' });
  });

  it('refuses a base that is no built-in skin, a scheme other than dark or light, and a name that is empty, long or not text', () => {
    for (const base of ['neon', 'Pixel', '__defineGetter__', 1]) expect(refused(file(raw => (raw.base = base))), String(base)).toEqual({ code: 'bad_base', key: 'base' });
    for (const scheme of ['system', 'Dark', 1]) expect(refused(file(raw => (raw.color_scheme = scheme)))).toEqual({ code: 'bad_scheme', key: 'color_scheme' });
    for (const name of ['', '   ', 'x'.repeat(121), 7]) expect(refused(file(raw => (names(raw).en = name)))).toEqual({ code: 'bad_name', key: 'name.en' });
    expect(refused(file(raw => (names(raw).ru = 'я'.repeat(120))))).toBeNull();
    expect(refused(file(raw => (names(raw).en = 'Night shift: 2 (beta) & Co!')))).toBeNull();
    expect(refused(file(raw => (raw.name = 'Night shift')))).toEqual({ code: 'not_object', key: 'name' });
  });

  it('asks for every field and names the first one missing', () => {
    for (const key of ['base', 'name', 'color_scheme', 'colors', 'fonts', 'cut']) expect(refused(file(raw => delete raw[key])), key).toEqual({ code: 'missing', key });
    expect(refused(file(raw => delete colors(raw).scrim))).toEqual({ code: 'missing', key: 'colors.scrim' });
    expect(refused(file(raw => delete fonts(raw).mono))).toEqual({ code: 'missing', key: 'fonts.mono' });
    expect(refused(file(raw => delete names(raw).ru))).toEqual({ code: 'missing', key: 'name.ru' });
    expect(refused(file(raw => (raw.colors = ['#000000'])))).toEqual({ code: 'not_object', key: 'colors' });
    expect(refused(file(raw => (raw.fonts = 'sans-serif')))).toEqual({ code: 'not_object', key: 'fonts' });
  });

  it('refuses colours that are hard to read, naming the text and what it stands on', () => {
    expect(refused(file(raw => (colors(raw).muted = '#55556A')))).toEqual({ code: 'low_contrast', key: 'muted', value: 'bg' });
    expect(refused(file(raw => (colors(raw).on_button = '#FFFFFF')))).toEqual({ code: 'low_contrast', key: 'on_button', value: 'button' });
    expect(refused(file(raw => (colors(raw).line2 = '#42425C')))).toEqual({ code: 'faint_line', key: 'line2', value: 'bg' });
  });

  /* A button reads as a button only by its edge: its fill stands out from what it stands on at 3:1 (WCAG 1.4.11), or a
     person sees words with no control around them (Design, #1960). */
  it('refuses a button whose fill fades into the ground it stands on, as a faint edge', () => {
    expect(refused(file(raw => Object.assign(colors(raw), { button: '#3A4250', on_button: '#FFFFFF' })))).toEqual({ code: 'faint_line', key: 'button', value: 'bg' });
  });

  it('refuses glass so thin that muted text on it fades over a white or a black page under it', () => {
    expect(refused(file(raw => (colors(raw).hud = 'rgba(26, 26, 43, .3)')))).toEqual({ code: 'low_contrast', key: 'muted', value: 'hud' });
    expect(refused(file(raw => (colors(raw).hud = 'rgba(255, 255, 255, .9)')))).toEqual({ code: 'low_contrast', key: 'muted', value: 'hud' });
    expect(refused(file(raw => (colors(raw).hud = 'rgba(26, 26, 43, .94)')))).toBeNull();
  });

  it('says what to fix in plain words in English and Russian for every refusal', () => {
    for (const code of [...SKIN_ERROR_CODES, 'read_failed'] as const) {
      for (const words of [en, ru]) {
        const text = words.skins.errors[code]('colors.bg', 'Comic Sans MS');
        expect(text, code).toMatch(/\S/);
        expect(text, code).not.toMatch(/[\u2014\u0451\u0401]/);
      }
    }
    expect(en.skins.errors.bad_color('colors.ink', '')).toBe('The colors.ink field needs a color in #RRGGBB or rgba() format. Fix the field and add the file again.');
    expect(ru.skins.errors.bad_color('colors.ink', '')).toBe('В поле colors.ink нужен цвет вида #RRGGBB или rgba(). Исправьте поле и добавьте файл снова.');
    expect(ru.skins.errors.bad_font('fonts.body', 'Handjet')).toBe('Шрифт «Handjet» не поддерживается для поля «fonts.body». Выберите шрифт из образца.');
    expect(en.skins.errors.low_contrast('muted', 'bg')).toBe('Text in \u201cmuted\u201d is hard to read on \u201cbg\u201d. Change one of the colors and add the file again.');
    expect(ru.skins.errors.layout_locked('grid', '')).toContain('grid');
  });
});
