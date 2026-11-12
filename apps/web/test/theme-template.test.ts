import { describe, expect, it } from 'vitest';
import {
  BUILTIN,
  COLOR_TOKENS,
  CUT_RANGE,
  CUT_TOKEN,
  declarations,
  FONT_TOKENS,
  parseTemplate,
  sampleOf,
  TEMPLATE_LIMIT,
  templateText,
  THEMES,
  type BuiltinTheme,
  type ColorRole,
  type TemplateError,
} from '../src/theme-template';
import { decl } from './css';

const MINIMAL = { format: 'hornhoof-theme', version: 1, base: 'dark' };
const parse = (value: unknown) => parseTemplate(typeof value === 'string' ? value : JSON.stringify(value));
function refusal(value: unknown): TemplateError {
  const result = parse(value);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(value)}`);
  return result.error;
}
const declared = (value: unknown) => {
  const result = parse(value);
  if (!result.ok) throw new Error(`refused ${JSON.stringify(result.error)}`);
  return Object.fromEntries(declarations(result.template));
};

describe('a theme template', () => {
  it.each(THEMES)('takes back the sample of %s it gives out, value for value', theme => {
    const result = parseTemplate(templateText(sampleOf(theme)));
    expect(result).toEqual({ ok: true, template: sampleOf(theme) });
  });

  it('changes only the values it names, on top of the built-in theme it starts from', () => {
    const tokens = declared({ ...MINIMAL, colors: { bg: '#000000', accent: 'rgba(0, 255, 0, .5)' } });
    expect(tokens).toEqual({ [COLOR_TOKENS.bg]: '#000000', [COLOR_TOKENS.accent]: 'rgba(0, 255, 0, .5)' });
  });

  it('writes a font list as a CSS stack and the corner cut as a number', () => {
    const tokens = declared({ ...MINIMAL, fonts: { body: ['Comic Neue', 'Segoe UI', 'sans-serif'] }, cut: 0.5, scheme: 'light' });
    expect(tokens).toEqual({ [FONT_TOKENS.body]: "'Comic Neue', 'Segoe UI', sans-serif", [CUT_TOKEN]: '0.5', 'color-scheme': 'light' });
  });

  it('gives out a whole sample with every token, so a person sees what can change', () => {
    const tokens = declared(JSON.parse(templateText(sampleOf('matrix'))));
    const known = [...Object.values(COLOR_TOKENS), ...Object.values(FONT_TOKENS), CUT_TOKEN, 'color-scheme'];
    expect(Object.keys(tokens).sort()).toEqual([...known].sort());
  });

  it.each([
    ['not JSON', '{"format": "hornhoof-theme",', { code: 'not_json' }],
    ['a list', [], { code: 'not_template' }],
    ['null', null, { code: 'not_template' }],
    ['no format', { version: 1, base: 'dark' }, { code: 'not_template' }],
    ['another format', { ...MINIMAL, format: 'vscode-theme' }, { code: 'not_template' }],
    ['another version', { ...MINIMAL, version: 2 }, { code: 'not_template' }],
    ['an unknown field', { ...MINIMAL, script: 'alert(1)' }, { code: 'unknown_key', key: 'script' }],
    ['an unknown colour', { ...MINIMAL, colors: { background: '#000000' } }, { code: 'unknown_key', key: 'colors.background' }],
    ['a prototype key', `{"format":"hornhoof-theme","version":1,"base":"dark","colors":{"__proto__":{"bg":"#000"}}}`, { code: 'unknown_key', key: 'colors.__proto__' }],
    ['an unknown font role', { ...MINIMAL, fonts: { heading: ['serif'] } }, { code: 'unknown_key', key: 'fonts.heading' }],
    ['colours as a list', { ...MINIMAL, colors: ['#000000'] }, { code: 'not_object', key: 'colors' }],
    ['fonts as text', { ...MINIMAL, fonts: 'serif' }, { code: 'not_object', key: 'fonts' }],
    ['no base', { format: 'hornhoof-theme', version: 1 }, { code: 'bad_base' }],
    ['an unknown base', { ...MINIMAL, base: 'solarized' }, { code: 'bad_base' }],
    ['an unknown scheme', { ...MINIMAL, scheme: 'auto' }, { code: 'bad_scheme' }],
    ['a name that is not text', { ...MINIMAL, name: 7 }, { code: 'bad_name' }],
    ['a name that is too long', { ...MINIMAL, name: 'n'.repeat(61) }, { code: 'bad_name' }],
  ])('refuses %s', (_what, value, error) => {
    expect(refusal(value)).toEqual(error);
  });

  it('refuses a file over the limit before it reads it as JSON', () => {
    expect(refusal(`{${' '.repeat(TEMPLATE_LIMIT)}`)).toEqual({ code: 'too_large' });
    expect(parse(JSON.stringify({ ...MINIMAL, name: 'n' }).padEnd(TEMPLATE_LIMIT, ' ')).ok).toBe(true);
  });

  it.each(['#0f0', '#0f08', '#00ff00', '#00FF0080', 'rgb(0, 255, 0)', 'rgba(0,255,0,.5)', 'rgba(0, 255, 0, 0.14)', 'rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 0)'])('takes the colour %s', color => {
    expect(declared({ ...MINIMAL, colors: { ink: color } })).toEqual({ [COLOR_TOKENS.ink]: color });
  });

  it.each([
    'url(https://example.com/a.png)',
    'URL( "x" )',
    '#fff url(x)',
    'expression(alert(1))',
    '<script>alert(1)</script>',
    '#fff</style>',
    '#fff; background: red',
    '#fff} body { color: red',
    'var(--ink)',
    'javascript:alert(1)',
    'image(#fff)',
    'attr(title)',
    'env(safe-area-inset-top)',
    '\\75 rl(x)',
    '#fff/**/',
    '@import "x"',
    '#fff\u0000',
    '#fff\n',
    '\u202e#fff',
    '#fff\u200b',
  ])('refuses code in a colour: %j', value => {
    expect(refusal({ ...MINIMAL, colors: { bg: value } })).toEqual({ code: 'unsafe', key: 'colors.bg' });
  });

  it.each(['red', 'transparent', 'currentColor', '#ggg', '#12345', '#1234567', 'rgb(256, 0, 0)', 'rgb(0, 0)', 'rgba(0, 0, 0, 1.5)', 'rgba(0, 0, 0, -1)', 'rgb(-1, 0, 0)', 'hsl(0 0% 0%)', 'rgb(0 0 0)', ' #fff', '', 'n'.repeat(41), 0, null, ['#fff']])('refuses %j as a colour', value => {
    expect(refusal({ ...MINIMAL, colors: { surface: value } })).toEqual({ code: 'bad_color', key: 'colors.surface' });
  });

  it.each([
    [['Onest', 'url(x)', 'sans-serif']],
    [["Onest'; color: red", 'sans-serif']],
    [['Onest', '<b>', 'serif']],
    [['On\u0000est', 'serif']],
    [['var(--f-body)', 'serif']],
  ])('refuses code in a font list: %j', fonts => {
    expect(refusal({ ...MINIMAL, fonts: { display: fonts } })).toEqual({ code: 'unsafe', key: 'fonts.display' });
  });

  it.each([
    [['Onest']],
    [[]],
    [['Onest, Arial', 'sans-serif']],
    [['"Onest"', 'sans-serif']],
    [['', 'sans-serif']],
    [[' Onest', 'sans-serif']],
    [['n'.repeat(41), 'sans-serif']],
    [['A', 'B', 'C', 'D', 'E', 'F', 'serif']],
    [[7, 'serif']],
    ['serif'],
  ])('refuses %j as a font list', fonts => {
    expect(refusal({ ...MINIMAL, fonts: { mono: fonts } })).toEqual({ code: 'bad_font', key: 'fonts.mono' });
  });

  it('takes a font list of up to six names that ends with a family every computer has', () => {
    expect(declared({ ...MINIMAL, fonts: { mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'ui-monospace', 'monospace'] } })).toEqual({
      [FONT_TOKENS.mono]: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', ui-monospace, monospace",
    });
  });

  it('takes the corner cut from none up to half again the usual one, and nothing else', () => {
    expect(CUT_RANGE).toEqual({ min: 0, max: 1.5 });
    for (const cut of [0, 0.25, 1, 1.5]) expect(declared({ ...MINIMAL, cut })).toEqual({ [CUT_TOKEN]: String(cut) });
    for (const cut of [-0.01, 1.51, 2, 100, '1', true, null, [1]]) expect(refusal({ ...MINIMAL, cut }), String(cut)).toEqual({ code: 'bad_cut' });
  });

  it('refuses tags and control characters in the name and keeps an ordinary one', () => {
    expect(refusal({ ...MINIMAL, name: '<img src=x onerror=alert(1)>' })).toEqual({ code: 'unsafe', key: 'name' });
    expect(refusal({ ...MINIMAL, name: 'Neon\u0007' })).toEqual({ code: 'unsafe', key: 'name' });
    const result = parse({ ...MINIMAL, name: 'Неон, ночь 2' });
    expect(result.ok && result.template.name).toBe('Неон, ночь 2');
  });
});

/* The blocks of theme.css that hold each built-in theme, so the page and the samples it gives out never drift apart. */
const BLOCK: Record<BuiltinTheme, string> = { light: ':root', dark: ':root[data-theme="dark"]', matrix: ':root[data-theme="matrix"]', cyberpunk: ':root[data-theme="cyberpunk"]' };
const value = (selector: string, property: string, media: string | null = null) => (decl(selector, property, media) ?? decl(':root', property))?.replace(/['"]/g, '').toLowerCase();
const stack = (fonts: string[]) => fonts.join(', ').toLowerCase();

describe('the built-in themes', () => {
  it.each(THEMES)('%s in theme.css matches its sample, token for token', theme => {
    const palette = BUILTIN[theme];
    for (const [role, token] of Object.entries(COLOR_TOKENS)) expect(value(BLOCK[theme], token), `${theme} ${role}`).toBe(palette.colors[role as ColorRole].toLowerCase());
    for (const [role, token] of Object.entries(FONT_TOKENS)) expect(value(BLOCK[theme], token), `${theme} ${role}`).toBe(stack(palette.fonts[role as keyof typeof FONT_TOKENS]));
    expect(value(BLOCK[theme], CUT_TOKEN)).toBe(String(palette.cut));
    expect(value(BLOCK[theme], 'color-scheme')).toBe(palette.scheme);
  });

  it('follows a dark system with the dark theme when nothing is chosen', () => {
    for (const [role, token] of Object.entries(COLOR_TOKENS)) {
      expect(value(':root:not([data-theme="light"])', token, '(prefers-color-scheme: dark)'), role).toBe(BUILTIN.dark.colors[role as ColorRole].toLowerCase());
    }
  });

  it('keeps the same fonts in every built-in theme, so no text and no block moves when the theme changes', () => {
    for (const theme of THEMES) expect(BUILTIN[theme].fonts, theme).toEqual(BUILTIN.light.fonts);
  });

  it('cuts no corners in Matrix and keeps the usual cut in the others', () => {
    expect(THEMES.map(theme => [theme, BUILTIN[theme].cut])).toEqual([['light', 1], ['dark', 1], ['matrix', 0], ['cyberpunk', 1]]);
  });
});

/* WCAG 2 contrast of two colours of a theme, the upper one laid over the lower when it lets some through. */
type Rgba = [number, number, number, number];
function rgba(color: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16), 1];
  const fn = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(color);
  if (!fn) throw new Error(`not a colour of the sheet: ${color}`);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
}
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => [r, g, b].map(c => c / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
function contrast(theme: BuiltinTheme, text: ColorRole, ground: ColorRole): number {
  const colors = BUILTIN[theme].colors;
  const back = over(rgba(colors[ground]), rgba(colors.bg));
  const [a, b] = [luminance(over(rgba(colors[text]), back)), luminance(back)].sort((x, y) => y - x);
  return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
}
const SURFACES: ColorRole[] = ['bg', 'surface', 'surface2', 'hud'];
const TEXT: ColorRole[] = ['ink', 'muted', 'accent_ink', 'warning_ink', 'attention_ink', 'success', 'danger', 'provider_claude', 'provider_kimi', 'provider_glm', 'provider_antigravity'];

describe('contrast of the built-in themes', () => {
  it.each(THEMES)('keeps main and secondary text and the button readable in %s', theme => {
    for (const text of ['ink', 'muted'] as const) for (const ground of SURFACES) expect(contrast(theme, text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'on_button', 'button')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'on_danger', 'danger')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['matrix', 'cyberpunk'] as const)('keeps every coloured text, control line and focus ring readable in %s', theme => {
    for (const text of TEXT) for (const ground of SURFACES) expect(contrast(theme, text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    for (const line of ['line2', 'accent', 'accent_ink'] as const) for (const ground of ['bg', 'surface', 'surface2'] as const) expect(contrast(theme, line, ground), `${line} on ${ground}`).toBeGreaterThanOrEqual(3);
  });
});
