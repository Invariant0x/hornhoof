/* The themes of the page and the custom template a person loads from a JSON file. A theme changes only visual tokens:
   colours, font families and how far corners are cut. Sizes, gaps and the layout stay the same in every theme. This file
   has no imports and touches no page, so the script that sets the theme before the page draws can carry it whole. */

export const THEMES = ['light', 'dark', 'matrix', 'cyberpunk'] as const;
export type BuiltinTheme = (typeof THEMES)[number];
export const isBuiltinTheme = (value: unknown): value is BuiltinTheme => (THEMES as readonly unknown[]).includes(value);

/* The role a template names, and the token of theme.css it sets. */
export const COLOR_TOKENS = {
  bg: '--bg',
  surface: '--surface',
  surface2: '--surface2',
  line: '--line',
  line2: '--line2',
  ink: '--ink',
  muted: '--muted',
  accent: '--cyan',
  accent_ink: '--cyan-ink',
  warning: '--amber',
  warning_ink: '--amber-ink',
  attention: '--pink',
  attention_ink: '--pink-ink',
  success: '--ok',
  danger: '--red',
  on_danger: '--on-red',
  idle: '--idle',
  dot: '--dot',
  glow: '--glow',
  button: '--btn',
  on_button: '--on-btn',
  hud: '--hud',
  shadow: '--shadow',
  provider_claude: '--p-claude',
  provider_kimi: '--p-kimi',
  provider_glm: '--p-glm',
  provider_antigravity: '--p-antigravity',
} as const;
export type ColorRole = keyof typeof COLOR_TOKENS;
export const FONT_TOKENS = { display: '--f-display', body: '--f-body', mono: '--f-mono' } as const;
export type FontRole = keyof typeof FONT_TOKENS;
/* Every cut corner is its usual size times this number: 0 is square, 1 the usual cut. */
export const CUT_TOKEN = '--cut-k';
export const CUT_RANGE = { min: 0, max: 1.5 };
/* Characters of a template file; a sample takes under 2 000. */
export const TEMPLATE_LIMIT = 64 * 1024;

type Scheme = 'light' | 'dark';
export type Palette = { scheme: Scheme; colors: Record<ColorRole, string>; fonts: Record<FontRole, string[]>; cut: number };
export type Template = { name: string; base: BuiltinTheme; scheme?: Scheme; colors: Partial<Record<ColorRole, string>>; fonts: Partial<Record<FontRole, string[]>>; cut?: number };
export type TemplateError = {
  code: 'too_large' | 'not_json' | 'not_template' | 'unknown_key' | 'not_object' | 'bad_base' | 'bad_scheme' | 'bad_name' | 'unsafe' | 'bad_color' | 'bad_font' | 'bad_cut';
  key?: string;
};
export type Parsed = { ok: true; template: Template } | { ok: false; error: TemplateError };

/* One set of fonts for every built-in theme: a font of its own would move text and blocks when the theme changes. */
const FONTS: Record<FontRole, string[]> = {
  display: ['Tektur', 'Onest', 'system-ui', 'sans-serif'],
  body: ['Onest', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
};

/* The same values as the blocks of theme.css; a test holds the two together. */
export const BUILTIN: Record<BuiltinTheme, Palette> = {
  light: {
    scheme: 'light',
    cut: 1,
    fonts: FONTS,
    colors: {
      bg: '#E6EBF0', surface: '#F8FAFC', surface2: '#EEF2F6', line: '#C9D3DD', line2: '#A9B7C5', ink: '#0F1B27', muted: '#4C5A68',
      accent: '#00A3BD', accent_ink: '#00768A', warning: '#E08A00', warning_ink: '#9A5A00', attention: '#E0307F', attention_ink: '#B0185F',
      success: '#1E8E4E', danger: '#D32F2F', on_danger: '#FFFFFF', idle: '#C5D0DB', dot: 'rgba(30, 60, 90, .17)', glow: 'rgba(0, 163, 189, .10)',
      button: '#00768A', on_button: '#FFFFFF', hud: 'rgba(240, 244, 247, .88)', shadow: 'rgba(20, 40, 60, .18)',
      provider_claude: '#C2593A', provider_kimi: '#1667E0', provider_glm: '#3D47D6', provider_antigravity: '#1E8E3E',
    },
  },
  dark: {
    scheme: 'dark',
    cut: 1,
    fonts: FONTS,
    colors: {
      bg: '#141A22', surface: '#1B232D', surface2: '#212B37', line: '#2C3845', line2: '#3D4C5C', ink: '#E3EAF1', muted: '#93A0AE',
      accent: '#46E0EF', accent_ink: '#6FE9F5', warning: '#FFB54A', warning_ink: '#FFC36E', attention: '#FF62AA', attention_ink: '#FF8CC2',
      success: '#5FD08A', danger: '#FF6B6B', on_danger: '#2A0606', idle: '#2C3744', dot: 'rgba(140, 175, 205, .15)', glow: 'rgba(70, 224, 239, .10)',
      button: '#46E0EF', on_button: '#05222A', hud: 'rgba(23, 30, 39, .84)', shadow: 'rgba(0, 0, 0, .45)',
      provider_claude: '#F08A66', provider_kimi: '#5E9BFF', provider_glm: '#8D95FF', provider_antigravity: '#6DD58C',
    },
  },
  /* Phosphor green on near black, square frames. Roles leave green so they stay apart: success jade, warning amber. */
  matrix: {
    scheme: 'dark',
    cut: 0,
    fonts: FONTS,
    colors: {
      bg: '#050A06', surface: '#0A130D', surface2: '#101D14', line: '#1E3525', line2: '#4A7856', ink: '#D4F7DC', muted: '#84B390',
      accent: '#00E05A', accent_ink: '#66FF99', warning: '#E5B82E', warning_ink: '#F5CD56', attention: '#F25C9A', attention_ink: '#FF8AB8',
      success: '#42DEC2', danger: '#FF5247', on_danger: '#260402', idle: '#1B3021', dot: 'rgba(82, 224, 128, .16)', glow: 'rgba(0, 224, 90, .14)',
      button: '#00E05A', on_button: '#021C0B', hud: 'rgba(8, 16, 11, .88)', shadow: 'rgba(0, 0, 0, .62)',
      provider_claude: '#F08A66', provider_kimi: '#639EFF', provider_glm: '#8F97FF', provider_antigravity: '#6EE08E',
    },
  },
  /* A night of deep violet with neon: cyan lines and links, a yellow main button, magenta for attention and its glow. */
  cyberpunk: {
    scheme: 'dark',
    cut: 1,
    fonts: FONTS,
    colors: {
      bg: '#0B0720', surface: '#140D33', surface2: '#1C1342', line: '#33275E', line2: '#7E6BC4', ink: '#F5F0FF', muted: '#B9AEE0',
      accent: '#00E5FF', accent_ink: '#5CF0FF', warning: '#FF9E2C', warning_ink: '#FFB866', attention: '#FF2BD6', attention_ink: '#FF7AE5',
      success: '#3DFFA8', danger: '#FF4766', on_danger: '#1A0008', idle: '#2A1F55', dot: 'rgba(0, 229, 255, .14)', glow: 'rgba(255, 43, 214, .16)',
      button: '#FCEE0A', on_button: '#1A1400', hud: 'rgba(17, 11, 43, .86)', shadow: 'rgba(0, 0, 0, .6)',
      provider_claude: '#FF9A73', provider_kimi: '#73A9FF', provider_glm: '#A3A9FF', provider_antigravity: '#6FE592',
    },
  },
};

const FORMAT = 'hornhoof-theme';
const VERSION = 1;
const TOP_KEYS = ['format', 'version', 'name', 'base', 'scheme', 'colors', 'fonts', 'cut'];
const NAME_LIMIT = 60;
const FONT_LIMIT = 6;

/* What would make a value more than a colour or a font name: a link, a function that reads something, a way out of the
   declaration or of the stylesheet, an escape, a comment, a control or a direction character. Checked before the form,
   so code is named as code. */
const UNSAFE = /url\s*\(|expression\s*\(|image\s*\(|attr\s*\(|env\s*\(|var\s*\(|javascript:|@import|[<>;{}\\]|\/\*|[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3})(?:, ?(0|1|0?\.\d{1,4}|1\.0{1,4}))?\)$/;
/* Family names go out in quotes, so a name holds only Latin letters, digits, spaces and hyphens. */
const FONT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,38}[A-Za-z0-9])?$/;
const GENERIC = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'];
/* Keywords of system fonts that work only without quotes; a list never ends with one. */
const SYSTEM = ['-apple-system', 'BlinkMacSystemFont'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unsafe = (value: unknown) => typeof value === 'string' && UNSAFE.test(value);

function isColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (HEX.test(value)) return true;
  const rgb = RGB.exec(value);
  return !!rgb && [rgb[1], rgb[2], rgb[3]].every(channel => Number(channel) <= 255);
}

function isFontList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > FONT_LIMIT) return false;
  const known = (name: unknown) => typeof name === 'string' && (GENERIC.includes(name) || SYSTEM.includes(name) || FONT_NAME.test(name));
  return value.every(known) && GENERIC.includes(value[value.length - 1] as string);
}

const fail = (code: TemplateError['code'], key?: string): Parsed => ({ ok: false, error: key === undefined ? { code } : { code, key } });

/* Reads one section of named values: every key known, every value safe and of its form. */
function section<T>(raw: unknown, name: string, roles: readonly string[], valid: (value: unknown) => value is T, bad: TemplateError['code']): { values: Record<string, T> } | Parsed {
  if (raw === undefined) return { values: {} };
  if (!isObject(raw)) return fail('not_object', name);
  const values: Record<string, T> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!roles.includes(key)) return fail('unknown_key', `${name}.${key}`);
    if (unsafe(value) || (Array.isArray(value) && value.some(unsafe))) return fail('unsafe', `${name}.${key}`);
    if (!valid(value)) return fail(bad, `${name}.${key}`);
    values[key] = Array.isArray(value) ? ([...value] as T) : value;
  }
  return { values };
}

function readName(raw: unknown): string | Parsed {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return fail('bad_name');
  if (unsafe(raw)) return fail('unsafe', 'name');
  return raw.length > NAME_LIMIT ? fail('bad_name') : raw;
}

const isCut = (raw: unknown): raw is number => typeof raw === 'number' && raw >= CUT_RANGE.min && raw <= CUT_RANGE.max;

/* Reads a template file strictly: a value is taken only when it is known, safe and of its form, and the first one that is
   not names what is wrong. */
export function parseTemplate(text: string): Parsed {
  if (text.length > TEMPLATE_LIMIT) return fail('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not_json');
  }
  if (!isObject(raw) || raw.format !== FORMAT || raw.version !== VERSION) return fail('not_template');
  const extra = Object.keys(raw).find(key => !TOP_KEYS.includes(key));
  if (extra !== undefined) return fail('unknown_key', extra);
  const name = readName(raw.name);
  if (typeof name !== 'string') return name;
  if (!isBuiltinTheme(raw.base)) return fail('bad_base');
  if (raw.scheme !== undefined && raw.scheme !== 'light' && raw.scheme !== 'dark') return fail('bad_scheme');
  const colors = section(raw.colors, 'colors', Object.keys(COLOR_TOKENS), isColor, 'bad_color');
  if (!('values' in colors)) return colors;
  const fonts = section(raw.fonts, 'fonts', Object.keys(FONT_TOKENS), isFontList, 'bad_font');
  if (!('values' in fonts)) return fonts;
  if (raw.cut !== undefined && !isCut(raw.cut)) return fail('bad_cut');
  const template: Template = { name, base: raw.base, colors: colors.values, fonts: fonts.values };
  if (raw.scheme !== undefined) template.scheme = raw.scheme;
  if (raw.cut !== undefined) template.cut = raw.cut;
  return { ok: true, template };
}

/* A whole template of a built-in theme, every value written out, to start a custom one from. */
export function sampleOf(theme: BuiltinTheme): Template {
  const palette = BUILTIN[theme];
  const fonts = Object.fromEntries(Object.entries(palette.fonts).map(([role, list]) => [role, [...list]])) as Record<FontRole, string[]>;
  return { name: '', base: theme, scheme: palette.scheme, colors: { ...palette.colors }, fonts, cut: palette.cut };
}

/* The template with every value it leaves out taken from its base. */
export function filledIn(template: Template): Template {
  const sample = sampleOf(template.base);
  return { ...sample, ...template, colors: { ...sample.colors, ...template.colors }, fonts: { ...sample.fonts, ...template.fonts } };
}

export function templateText(template: Template): string {
  const { name, base, scheme, colors, fonts, cut } = template;
  return `${JSON.stringify({ format: FORMAT, version: VERSION, name, base, scheme, colors, fonts, cut }, null, 2)}\n`;
}

const fontStack = (fonts: string[]) => fonts.map(font => (GENERIC.includes(font) || SYSTEM.includes(font) ? font : `'${font}'`)).join(', ');

/* The tokens a template sets on the page, over the block of its base theme in theme.css. */
export function declarations(template: Template): [string, string][] {
  const out: [string, string][] = [];
  for (const [role, color] of Object.entries(template.colors)) out.push([COLOR_TOKENS[role as ColorRole], color]);
  for (const [role, fonts] of Object.entries(template.fonts)) out.push([FONT_TOKENS[role as FontRole], fontStack(fonts)]);
  if (template.cut !== undefined) out.push([CUT_TOKEN, String(template.cut)]);
  if (template.scheme !== undefined) out.push(['color-scheme', template.scheme]);
  return out;
}

/* Every property a template may set, so the page can take them all away again. */
export const TEMPLATE_PROPERTIES = [...Object.values(COLOR_TOKENS), ...Object.values(FONT_TOKENS), CUT_TOKEN, 'color-scheme'];
