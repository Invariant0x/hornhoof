import { COLOR_ROLES, CUT_RANGE, FONT_ROLES, GENERIC_FONTS, SCHEMES, SYSTEM_FONTS, type Scheme, type Skin } from './roles';

/* The strict check of a skin file a person loads, and the file Hornhoof gives out as a sample. A skin is taken only when
   it is whole and every value is known, safe and of its form; the first one that is not names what is wrong. Nothing of
   the file is kept: the skin is built anew from the values that passed. */

export const SKIN_FORMAT = 'hornhoof-skin';
export const SKIN_VERSION = 1;
/* Characters of a skin file; a sample takes about 2 000. */
export const SKIN_FILE_LIMIT = 16 * 1024;
const NAME_LIMIT = 60;
const FONT_LIMIT = 6;
const FIELDS = ['format', 'version', 'name', 'scheme', 'colors', 'fonts', 'cut'];

export const SKIN_ERROR_CODES = ['too_large', 'not_json', 'not_skin', 'forbidden_key', 'layout_locked', 'unknown_key', 'missing', 'not_object', 'bad_name', 'bad_scheme', 'unsafe', 'bad_color', 'bad_font', 'bad_cut'] as const;
export type SkinErrorCode = (typeof SKIN_ERROR_CODES)[number];
export type SkinError = { code: SkinErrorCode; key?: string };
export type ParsedSkin = { ok: true; skin: Skin } | { ok: false; error: SkinError };

/* Keys that reach the prototype of an object when code copies one: refused wherever they stand. */
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
/* What a key that tries to change the layout looks like: the grid, sizes, gaps, borders and radii stay the same in every
   skin. */
const LAYOUT = /grid|gap|spac|pad|margin|layout|size|width|height|radius|border|inset|offset|gutter|zoom|scale|position/i;
/* What would make a value more than a colour or a font name: a link, a function that reads something, a way out of the
   declaration or of the stylesheet, a tag, an escape, a comment, a control, a direction or an invisible character.
   Checked before the form, so code is named as code. */
const UNSAFE = /url\s*\(|expression\s*\(|image\s*\(|attr\s*\(|env\s*\(|var\s*\(|javascript:|@import|[<>;{}\\]|\/\*|[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3})(?:, ?(0|1|0?\.\d{1,4}|1\.0{1,4}))?\)$/;
/* Family names go out in quotes, so a name holds only Latin letters, digits, spaces and hyphens. */
const FONT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,38}[A-Za-z0-9])?$/;

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const unsafe = (value: unknown) => typeof value === 'string' && UNSAFE.test(value);
const problem = (code: SkinErrorCode, key?: string): SkinError => (key === undefined ? { code } : { code, key });

function isColor(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (HEX.test(value)) return true;
  const rgb = RGB.exec(value);
  return !!rgb && [rgb[1], rgb[2], rgb[3]].every(channel => Number(channel) <= 255);
}

const isFontName = (name: unknown) => typeof name === 'string' && (GENERIC_FONTS.includes(name) || SYSTEM_FONTS.includes(name) || FONT_NAME.test(name));
function isFontList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > FONT_LIMIT) return false;
  return value.every(isFontName) && GENERIC_FONTS.includes(value[value.length - 1] as string);
}

const isCut = (value: unknown): value is number => typeof value === 'number' && value >= CUT_RANGE.min && value <= CUT_RANGE.max;
const isScheme = (value: unknown): value is Scheme => (SCHEMES as readonly unknown[]).includes(value);

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

function checkName(name: unknown): SkinError | null {
  if (name === undefined) return problem('missing', 'name');
  if (typeof name !== 'string') return problem('bad_name');
  if (unsafe(name)) return problem('unsafe', 'name');
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed.length > NAME_LIMIT ? problem('bad_name') : null;
}

/* One value of a section: a known role, nothing that looks like code, and the form of its kind. */
function checkValue(where: string, value: unknown, valid: (value: unknown) => boolean, bad: SkinErrorCode): SkinError | null {
  if (unsafe(value) || (Array.isArray(value) && value.some(unsafe))) return problem('unsafe', where);
  return valid(value) ? null : problem(bad, where);
}

/* A section of named values, such as colors: an object with every role, each value passing. */
function checkSection(raw: unknown, name: string, roles: readonly string[], valid: (value: unknown) => boolean, bad: SkinErrorCode): SkinError | null {
  if (raw === undefined) return problem('missing', name);
  if (!isObject(raw)) return problem('not_object', name);
  for (const key of Object.keys(raw)) {
    const found = roles.includes(key) ? checkValue(`${name}.${key}`, raw[key], valid, bad) : stranger(key, `${name}.${key}`);
    if (found) return found;
  }
  const missing = roles.find(role => !(role in raw));
  return missing === undefined ? null : problem('missing', `${name}.${missing}`);
}

/* The checks of a skin in the order a person reads it; the first that fails says what is wrong. */
const CHECKS: ((raw: Raw) => SkinError | null)[] = [
  raw => {
    const extra = Object.keys(raw).find(key => !FIELDS.includes(key));
    return extra === undefined ? null : stranger(extra, extra);
  },
  raw => checkName(raw.name),
  raw => (raw.scheme === undefined ? problem('missing', 'scheme') : isScheme(raw.scheme) ? null : problem('bad_scheme')),
  raw => checkSection(raw.colors, 'colors', COLOR_ROLES, isColor, 'bad_color'),
  raw => checkSection(raw.fonts, 'fonts', FONT_ROLES, isFontList, 'bad_font'),
  raw => (raw.cut === undefined ? problem('missing', 'cut') : isCut(raw.cut) ? null : problem('bad_cut')),
];

const NOT_JSON = Symbol('not JSON');
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/* An object with a value for every role, in the order of the roles. */
const byRole = <R extends string, V>(roles: readonly R[], value: (role: R) => V) => Object.fromEntries(roles.map(role => [role, value(role)])) as Record<R, V>;

/* The skin of a file that passed every check, built anew in the order of the roles. */
function skinOf(raw: Raw): Skin {
  const colors = raw.colors as Record<string, string>;
  const fonts = raw.fonts as Record<string, string[]>;
  return {
    name: (raw.name as string).trim(),
    scheme: raw.scheme as Scheme,
    colors: byRole(COLOR_ROLES, role => colors[role]!),
    fonts: byRole(FONT_ROLES, role => [...fonts[role]!]),
    cut: raw.cut as number,
  };
}

function firstProblem(raw: unknown): SkinError | null {
  const forbidden = forbiddenKey(raw);
  if (forbidden !== null) return problem('forbidden_key', forbidden);
  if (!isObject(raw) || raw.format !== SKIN_FORMAT || raw.version !== SKIN_VERSION) return problem('not_skin');
  for (const check of CHECKS) {
    const found = check(raw);
    if (found) return found;
  }
  return null;
}

/* Reads a skin file strictly: too large, not JSON, a forbidden key anywhere, then each field in its order. */
export function parseSkin(text: string): ParsedSkin {
  if (text.length > SKIN_FILE_LIMIT) return { ok: false, error: problem('too_large') };
  const raw = readJson(text);
  if (raw === NOT_JSON) return { ok: false, error: problem('not_json') };
  const found = firstProblem(raw);
  return found ? { ok: false, error: found } : { ok: true, skin: skinOf(raw as Raw) };
}

/* A skin as the object of its file: format and version first, every field and every role in order. */
export function skinObject(skin: Skin): Raw {
  const colors = byRole(COLOR_ROLES, role => skin.colors[role]);
  const fonts = byRole(FONT_ROLES, role => [...skin.fonts[role]]);
  return { format: SKIN_FORMAT, version: SKIN_VERSION, name: skin.name, scheme: skin.scheme, colors, fonts, cut: skin.cut };
}

export const skinText = (skin: Skin): string => `${JSON.stringify(skinObject(skin), null, 2)}\n`;
