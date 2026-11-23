import { readColor, weakPair } from './contrast';
import { BUILTIN_SKINS, SHIPPED_FONTS, type BuiltinSkin } from './registry';
import {
  COLOR_ROLES, CUT_RANGE, CUT_SHAPES, FONT_ROLES, GENERIC_FONTS, SCHEMES, SURFACE_STYLES, WORLD_COLOR_ROLES,
  type ColorRole, type FontRole, type Scheme, type Skin, type SkinLook, type SkinNames,
} from './roles';

/* The strict check of a skin file a person adds, version 2 of the skin format, and the file Hornhoof
   gives out as a sample. A skin is taken only when it is whole and every value is known, safe, of its form and readable;
   the first one that is not names the field to fix. Nothing of the file is kept: the skin is built anew from the values
   that passed. */

const SKIN_SCHEMA_VERSION = 2;
/* Bytes of a skin file; a sample takes about 2 000. */
export const SKIN_FILE_LIMIT = 64 * 1024;
const NAME_LIMIT = 120;
const FIELDS = ['schema_version', 'base', 'name', 'color_scheme', 'colors', 'fonts', 'cut'];
const NAME_LANGUAGES = ['ru', 'en'] as const;

/* The fonts a file may name for each role: the ones Hornhoof ships and the common families behind them. With no repeats
   a list holds at most as many as its role allows, never more than six. */
export const FILE_FONTS: Readonly<Record<FontRole, readonly string[]>> = {
  display: ['Tektur', 'Handjet', 'Alegreya', 'Onest', 'system-ui', 'sans-serif', 'serif'],
  body: ['Golos Text', 'Onest', 'system-ui', 'sans-serif'],
  mono: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'],
};
/* Roles drawn over something else, which may let it show through. Text, lines and surfaces are always opaque. */
export const SEE_THROUGH: readonly ColorRole[] = ['dot', 'glow', 'hud', 'shadow', 'scrim'];

export const SKIN_ERROR_CODES = [
  'too_large', 'not_json', 'not_skin', 'forbidden_key', 'bad_version', 'layout_locked', 'unknown_key', 'missing', 'not_object', 'bad_base',
  'bad_name', 'bad_scheme', 'unsafe', 'bad_color', 'opaque', 'bad_font', 'font_list', 'bad_cut', 'low_contrast', 'faint_line',
  'bad_shape', 'bad_surface', 'bad_pulse',
] as const;
export type SkinErrorCode = (typeof SKIN_ERROR_CODES)[number];
/* What is wrong: the field to fix, and for a font or a pair of colours the value it is about. */
export type SkinError = { code: SkinErrorCode; key?: string; value?: string };
type ParsedSkin = { ok: true; skin: Skin } | { ok: false; error: SkinError };

/* Keys that reach the prototype of an object when code copies one: refused wherever they stand. */
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
/* What a key that tries to change the layout looks like: the grid, sizes, gaps, borders and radii stay the same in every
   skin. */
const LAYOUT = /grid|gap|spac|pad|margin|layout|size|width|height|radius|border|inset|offset|gutter|zoom|scale|position/i;
/* What would make a value more than a colour, a font name or a name: a link, a function that reads something, a way out
   of the declaration or of the stylesheet, a tag, an escape, a comment, a control, a direction or an invisible character.
   Checked before the form, so code is named as code. */
const UNSAFE = /url\s*\(|expression\s*\(|image\s*\(|attr\s*\(|env\s*\(|var\s*\(|javascript:|@import|[<>;{}\\]|\/\*|[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/i;
/* How much of a refused value an error repeats. */
const SHOWN = 40;

type Raw = Record<string, unknown>;
type Check = (raw: Raw) => SkinError | null;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const unsafe = (value: unknown) => typeof value === 'string' && UNSAFE.test(value);
const problem = (code: SkinErrorCode, key?: string, value?: string): SkinError => ({ code, ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) });
const isCut = (value: unknown): value is number => typeof value === 'number' && value >= CUT_RANGE.min && value <= CUT_RANGE.max;
const isScheme = (value: unknown): value is Scheme => (SCHEMES as readonly unknown[]).includes(value);
const isBase = (value: unknown) => BUILTIN_SKINS.some(skin => skin.id === value);

/* The first forbidden key anywhere in the file, with the path to it, walked without recursion so depth costs no stack. */
function forbiddenKey(root: unknown): string | null {
  const stack: [unknown, string][] = [[root, '']];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [value, path] = next;
    if (typeof value !== 'object' || value === null) continue;
    for (const key of Object.keys(value)) {
      const at = path ? `${path}.${key}` : key;
      if (FORBIDDEN.includes(key)) return at;
      stack.push([(value as Raw)[key], at]);
    }
  }
  return null;
}

/* A key no skin knows: one that reaches for the layout is named as such. */
const stranger = (key: string, where: string) => problem(LAYOUT.test(key) ? 'layout_locked' : 'unknown_key', where);

type EntryCheck<K extends string> = (where: string, key: K, value: unknown) => SkinError | null;

/* One value of a group: a key the group knows, nothing in it that reads as code, then the check of its own kind. */
function checkEntry<K extends string>(name: string, keys: readonly K[], key: string, value: unknown, check: EntryCheck<K>): SkinError | null {
  const where = `${name}.${key}`;
  if (!(keys as readonly string[]).includes(key)) return stranger(key, where);
  if (unsafe(value) || (Array.isArray(value) && value.some(unsafe))) return problem('unsafe', where);
  return check(where, key as K, value);
}

/* A group of named values, such as colors: an object with every key, each value passing its own check. */
function checkGroup<K extends string>(raw: unknown, name: string, keys: readonly K[], check: EntryCheck<K>): SkinError | null {
  if (raw === undefined) return problem('missing', name);
  if (!isObject(raw)) return problem('not_object', name);
  for (const key of Object.keys(raw)) {
    const found = checkEntry(name, keys, key, raw[key], check);
    if (found) return found;
  }
  const missing = keys.find(key => !(key in raw));
  return missing === undefined ? null : problem('missing', `${name}.${missing}`);
}

function checkName(where: string, _language: string, value: unknown): SkinError | null {
  const length = typeof value === 'string' ? value.trim().length : 0;
  return length === 0 || length > NAME_LIMIT ? problem('bad_name', where) : null;
}

function checkColor(where: string, role: ColorRole, value: unknown): SkinError | null {
  const color = typeof value === 'string' ? readColor(value) : null;
  if (!color) return problem('bad_color', where);
  return color.a < 1 && !SEE_THROUGH.includes(role) ? problem('opaque', where) : null;
}

const MAX_FONT_LIST = 6;

/* A list of up to six fonts the role allows, without repeats, that ends with a common family. */
function checkFonts(where: string, role: FontRole, value: unknown): SkinError | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FONT_LIST) return problem('font_list', where);
  const foreign = value.find(font => !FILE_FONTS[role].includes(font as string));
  if (foreign !== undefined) return problem('bad_font', where, String(foreign).slice(0, SHOWN));
  return new Set(value).size === value.length && GENERIC_FONTS.includes(value[value.length - 1] as string) ? null : problem('font_list', where);
}

function checkContrast(raw: Raw): SkinError | null {
  const weak = weakPair(raw.colors as Skin['colors']);
  return weak && problem(weak.kind === 'text' ? 'low_contrast' : 'faint_line', weak.text, weak.on);
}

/* The checks of a skin in the order a person reads its file; the first that fails says what is wrong. */
const CHECKS: Check[] = [
  raw => {
    const extra = Object.keys(raw).find(key => !FIELDS.includes(key));
    return extra === undefined ? null : stranger(extra, extra);
  },
  raw => (raw.base === undefined ? problem('missing', 'base') : isBase(raw.base) ? null : problem('bad_base', 'base')),
  raw => checkGroup(raw.name, 'name', NAME_LANGUAGES, checkName),
  raw => (raw.color_scheme === undefined ? problem('missing', 'color_scheme') : isScheme(raw.color_scheme) ? null : problem('bad_scheme', 'color_scheme')),
  raw => checkGroup(raw.colors, 'colors', COLOR_ROLES, checkColor),
  raw => checkGroup(raw.fonts, 'fonts', FONT_ROLES, checkFonts),
  raw => (raw.cut === undefined ? problem('missing', 'cut') : isCut(raw.cut) ? null : problem('bad_cut', 'cut')),
  checkContrast,
];

const NOT_JSON = Symbol('not JSON');
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/* An object with a value for every key, in the order of the keys. */
const byKey = <K extends string, V>(keys: readonly K[], value: (key: K) => V) => Object.fromEntries(keys.map(key => [key, value(key)])) as Record<K, V>;

/* The skin of a file that passed every check, built anew in the order of the roles. */
function skinOf(raw: Raw): Skin {
  const names = raw.name as Record<string, string>;
  const colors = raw.colors as Record<string, string>;
  const fonts = raw.fonts as Record<string, string[]>;
  return {
    base: raw.base as string,
    name: byKey(NAME_LANGUAGES, language => names[language]!.trim()),
    scheme: raw.color_scheme as Scheme,
    colors: byKey(COLOR_ROLES, role => colors[role]!),
    fonts: byKey(FONT_ROLES, role => [...fonts[role]!]),
    cut: raw.cut as number,
  };
}

function firstProblem(raw: unknown): SkinError | null {
  const forbidden = forbiddenKey(raw);
  if (forbidden !== null) return problem('forbidden_key', forbidden);
  if (!isObject(raw) || raw.schema_version === undefined) return problem('not_skin');
  if (raw.schema_version !== SKIN_SCHEMA_VERSION) return problem('bad_version', 'schema_version');
  for (const check of CHECKS) {
    const found = check(raw);
    if (found) return found;
  }
  return null;
}

/* Reads a skin file strictly: too large, not JSON, a forbidden key anywhere, the version, then each field in its order,
   then the contrast of its colours. */
export function parseSkin(text: string): ParsedSkin {
  if (new TextEncoder().encode(text).length > SKIN_FILE_LIMIT) return { ok: false, error: problem('too_large') };
  const raw = readJson(text);
  if (raw === NOT_JSON) return { ok: false, error: problem('not_json') };
  const found = firstProblem(raw);
  return found ? { ok: false, error: found } : { ok: true, skin: skinOf(raw as Raw) };
}

/* A skin as the object of its file: the version first, every field and every role in order. */
export function skinObject(skin: Skin): Raw {
  return {
    schema_version: SKIN_SCHEMA_VERSION,
    base: skin.base,
    name: byKey(NAME_LANGUAGES, language => skin.name[language]),
    color_scheme: skin.scheme,
    colors: byKey(COLOR_ROLES, role => skin.colors[role]),
    fonts: byKey(FONT_ROLES, role => [...skin.fonts[role]]),
    cut: skin.cut,
  };
}

export const skinText = (skin: Skin): string => `${JSON.stringify(skinObject(skin), null, 2)}\n`;

/* A built-in skin as a file to start one's own from: its values, with only the fonts a file may name. */
export const builtinFile = (skin: BuiltinSkin, name: SkinNames): Skin => ({
  base: skin.id,
  name,
  scheme: skin.scheme,
  colors: skin.colors,
  fonts: byKey(FONT_ROLES, role => skin.fonts[role].filter(font => FILE_FONTS[role].includes(font))),
  cut: skin.cut,
});

/* The look of a theme archive (docs/theme-archive.md, 3.1): the whole look of a built-in skin, checked by the same checks
   as a person's own skin file, with the fonts of the archive's own ui/fonts.json besides the shipped ones and the
   system fonts the built-in skins name. */
const LOOK_FIELDS = ['scheme', 'colors', 'fonts', 'cut', 'shape', 'pulse', 'surface', 'worldColors', 'terminal'];
const SYSTEM_FONTS = [...new Set(BUILTIN_SKINS.flatMap(skin => FONT_ROLES.flatMap(role => skin.fonts[role])))].filter(font => !GENERIC_FONTS.includes(font));
const TERMINAL_KEYS = ['bg', 'ink', 'cursor', 'cursorAccent', 'selection', 'selectionInk', 'idle', 'ansi'] as const;
const ANSI_COLORS = 16;
type ParsedLook = { ok: true; look: SkinLook } | { ok: false; error: SkinError };

function lookFonts(families: readonly string[]): EntryCheck<FontRole> {
  const allowed = new Set([...SHIPPED_FONTS, ...SYSTEM_FONTS, ...families, ...GENERIC_FONTS]);
  return (where, _role, value) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FONT_LIST) return problem('font_list', where);
    const foreign = value.find(font => typeof font !== 'string' || !allowed.has(font));
    if (foreign !== undefined) return problem('bad_font', where, String(foreign).slice(0, SHOWN));
    return new Set(value).size === value.length && GENERIC_FONTS.includes(value[value.length - 1] as string) ? null : problem('font_list', where);
  };
}

const plainColor: EntryCheck<string> = (where, _key, value) => (typeof value === 'string' && readColor(value) ? null : problem('bad_color', where));

function checkTerminal(raw: unknown): SkinError | null {
  if (!isObject(raw)) return problem('not_object', 'terminal');
  for (const key of Object.keys(raw)) {
    const found = checkEntry('terminal', TERMINAL_KEYS, key, raw[key], (where, name, value) => {
      if (name !== 'ansi') return plainColor(where, name, value);
      return Array.isArray(value) && value.length === ANSI_COLORS && value.every(color => typeof color === 'string' && readColor(color)) ? null : problem('bad_color', where);
    });
    if (found) return found;
  }
  return raw.bg === undefined ? problem('missing', 'terminal.bg') : raw.ink === undefined ? problem('missing', 'terminal.ink') : null;
}

function lookChecks(families: readonly string[]): Check[] {
  const optional = (key: string, check: Check): Check => raw => (raw[key] === undefined ? null : check(raw));
  return [
    raw => {
      const extra = Object.keys(raw).find(key => !LOOK_FIELDS.includes(key));
      return extra === undefined ? null : stranger(extra, extra);
    },
    raw => (raw.scheme === undefined ? problem('missing', 'scheme') : isScheme(raw.scheme) ? null : problem('bad_scheme', 'scheme')),
    raw => checkGroup(raw.colors, 'colors', COLOR_ROLES, checkColor),
    raw => checkGroup(raw.fonts, 'fonts', FONT_ROLES, lookFonts(families)),
    raw => (raw.cut === undefined ? problem('missing', 'cut') : isCut(raw.cut) ? null : problem('bad_cut', 'cut')),
    raw => (raw.shape === undefined ? problem('missing', 'shape') : (CUT_SHAPES as readonly unknown[]).includes(raw.shape) ? null : problem('bad_shape', 'shape')),
    optional('pulse', raw => (typeof raw.pulse === 'number' && raw.pulse > 0 && raw.pulse <= 1 ? null : problem('bad_pulse', 'pulse'))),
    optional('surface', raw => ((SURFACE_STYLES as readonly unknown[]).includes(raw.surface) ? null : problem('bad_surface', 'surface'))),
    optional('worldColors', raw => checkGroup(raw.worldColors, 'worldColors', WORLD_COLOR_ROLES, plainColor)),
    optional('terminal', raw => checkTerminal(raw.terminal)),
    checkContrast,
  ];
}

/* Reads the look of a theme archive strictly, the first problem saying what to fix; the look is built anew from what passed. */
export function parseLook(raw: unknown, families: readonly string[]): ParsedLook {
  const forbidden = forbiddenKey(raw);
  if (forbidden !== null) return { ok: false, error: problem('forbidden_key', forbidden) };
  if (!isObject(raw)) return { ok: false, error: problem('not_skin') };
  for (const check of lookChecks(families)) {
    const found = check(raw);
    if (found) return { ok: false, error: found };
  }
  const colors = raw.colors as Record<string, string>;
  const fonts = raw.fonts as Record<string, string[]>;
  const look: SkinLook = {
    scheme: raw.scheme as Scheme,
    colors: byKey(COLOR_ROLES, role => colors[role]!),
    fonts: byKey(FONT_ROLES, role => [...fonts[role]!]),
    cut: raw.cut as number,
    shape: raw.shape as SkinLook['shape'],
    ...(raw.pulse === undefined ? {} : { pulse: raw.pulse as number }),
    ...(raw.surface === undefined ? {} : { surface: raw.surface as NonNullable<SkinLook['surface']> }),
    ...(raw.worldColors === undefined ? {} : { worldColors: byKey(WORLD_COLOR_ROLES, role => (raw.worldColors as Record<string, string>)[role]!) }),
    ...(raw.terminal === undefined ? {} : { terminal: Object.fromEntries(TERMINAL_KEYS.filter(key => (raw.terminal as Raw)[key] !== undefined).map(key => [key, (raw.terminal as Raw)[key]])) as unknown as NonNullable<SkinLook['terminal']> }),
  };
  return { ok: true, look };
}
