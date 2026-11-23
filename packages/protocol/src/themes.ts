/* A theme as one archive (docs/theme-archive.md): what Hornhoof says of an archive it refuses, the limits it holds an
   archive to, and how an installed theme is shown. The server checks; the screens name each problem in every language. */

export const THEME_ARCHIVE_FORMAT = 1;
export const THEME_ENGINES = ['none', 'iso2d', '3d'] as const;
export type ThemeEngine = (typeof THEME_ENGINES)[number];

/* Why an archive is refused. Each names one thing the author can fix, with the file it is about where there is one. */
export const THEME_PROBLEMS = [
  /* The zip itself. */
  'not_zip', 'zip_split', 'zip64', 'zip_encrypted', 'zip_method', 'zip_corrupt',
  /* Its size. */
  'archive_too_large', 'unpacked_too_large', 'too_many_files', 'file_too_large', 'packed_too_tightly',
  /* Its paths. */
  'path_unsafe', 'path_link', 'path_twice', 'path_outside',
  /* Its files: a script or a page, a file with no place in a theme, bytes that are not what the name says, a picture
     too large, text that is not plain, JSON that is not JSON or not of its shape, a link out, a file a JSON names that is
     not there, or one file too many of a kind. */
  'file_script', 'file_place', 'file_bytes', 'image_too_large', 'text_not_plain', 'json_bad', 'json_shape', 'link_outside', 'file_missing', 'too_many_of_kind',
  /* A drawing of the kit with more in it than shapes: a script, an event, a style sheet, a foreign object or the like. */
  'svg_unsafe',
  /* The theme as a whole. */
  'theme_missing', 'license_missing', 'look_missing', 'engine_3d', 'engine_none_world', 'world_missing', 'same_version',
  /* Its parts, refused by the check of each with that check's own words in detail. */
  'look_bad', 'fonts_bad', 'kit_bad', 'world_bad', 'art_bad', 'skills_bad',
] as const;
export type ThemeProblemCode = (typeof THEME_PROBLEMS)[number];

/* One problem: what is wrong, the archive's path it is about, and for a value the value as far as it may be shown. */
export type ThemeProblem = Readonly<{ code: ThemeProblemCode; path?: string; detail?: string }>;

/* Bytes and counts an archive is held to; docs/theme-archive.md section 8 gives them to authors. */
export const THEME_LIMITS = {
  archiveBytes: 200 * 1024 * 1024,
  unpackedBytes: 400 * 1024 * 1024,
  files: 5000,
  fileBytes: 16 * 1024 * 1024,
  /* How many times its packed size a file may grow, once it is larger than ratioFrom when unpacked. */
  ratio: 100,
  ratioFrom: 1024 * 1024,
  pathLength: 200,
} as const;
export type ThemeLimits = Readonly<Record<keyof typeof THEME_LIMITS, number>>;

export const THEME_FILE_LIMITS = {
  jsonBytes: 1024 * 1024,
  worldBytes: 2 * 1024 * 1024,
  passportBytes: 64 * 1024,
  textBytes: 64 * 1024,
  fontBytes: 2 * 1024 * 1024,
  kitBytes: 2 * 1024 * 1024,
  fonts: 24,
  imageSide: 8192,
  imagePixels: 50_000_000,
  previewBytes: 2 * 1024 * 1024,
  previewSide: 2560,
  shots: 6,
  /* How much of a refused value a problem repeats. */
  shown: 80,
} as const;

/* The parts of the interface a kit may paint, by the names the screens draw them under (docs/theme-archive.md, 3.3),
   and the colours it may set beside them. A kit names no other part or colour. Preliminary: from draft 0.3 of the
   Egypt UI kit (#1970), compared again with its 1.0. */
export const THEME_KIT_SLOTS = [
  /* Frames, nine-sliced. */
  'dialog', 'window', 'drawer', 'menu', 'card', 'table', 'plaque-frame', 'tile',
  /* Fills, tiled. */
  'ground', 'panel', 'dialog-fill', 'plaque', 'band',
  /* Controls, a plate for each state. */
  'btn', 'btn-hover', 'btn-pressed', 'btn-disabled', 'ghost', 'ghost-hover', 'ghost-pressed', 'ghost-disabled',
  'danger', 'danger-hover', 'chip', 'chip-on', 'field', 'field-focus', 'iconbtn', 'iconbtn-pressed',
  /* Small parts. */
  'counter', 'badge', 'check', 'corner', 'tab-on', 'tab', 'tab-sel', 'pill-ok', 'pill-bad',
  /* Strips. */
  'thead', 'row-hover', 'row-selected', 'track', 'fill', 'divider',
] as const;
export type ThemeKitSlot = (typeof THEME_KIT_SLOTS)[number];
export const THEME_KIT_COLORS = ['tab-ink', 'tab-on-ink', 'chip-on-ink', 'danger-ink', 'badge-ink', 'scroll-thumb', 'scroll-track'] as const;
export type ThemeKitColor = (typeof THEME_KIT_COLORS)[number];

/* An installed theme as the store shows it. */
export type InstalledThemeView = Readonly<{
  id: string;
  version: string;
  name: Readonly<Record<string, string>>;
  description: Readonly<Record<string, string>> | null;
  author: string;
  license: string;
  engine: ThemeEngine;
  languages: readonly string[];
  /* Where the theme's files are served, ending in a slash: preview/cover.png and the rest below it. */
  base: string;
  cover: string | null;
  shots: readonly string[];
  hasWorld: boolean;
  hasKit: boolean;
  size: number;
  installedAt: string;
}>;

/* The checks of a theme's look and world that the screens' own code holds: the skin check of an own skin file and the
   world pack and art checks of the packs Hornhoof ships. The web build gives them to the server as one module, so an
   uploaded theme is held to exactly what Hornhoof's own themes are. */
export type ThemeArtFile = Readonly<{ path: string; head: Uint8Array; passport?: unknown }>;
export type ThemeWorldInput = Readonly<{ id: string; world: unknown; baseUrl: string; art: readonly ThemeArtFile[]; files: readonly string[] }>;
export type ThemeCheckResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; detail: string }>;
export type ThemeWebCheck = Readonly<{
  checkLook: (raw: unknown, families: readonly string[]) => ThemeCheckResult<unknown>;
  checkWorld: (input: ThemeWorldInput) => Readonly<{ ok: true; world: unknown; artIndex: unknown }> | Readonly<{ ok: false; code: 'world_bad' | 'art_bad'; detail: string }>;
}>;
