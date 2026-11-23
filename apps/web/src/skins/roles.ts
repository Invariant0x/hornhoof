/* What a skin may set on the page: the value of each colour role, three font stacks, how far corners are cut and the
   shape of the cut. Sizes, gaps and the layout are the same in every skin, so a skin has no word for them. This module
   has no imports and touches no page, so the script that puts the skin on before the page draws can carry it whole. */

/* The role a skin names, and the token of theme.css it sets. */
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
  on_attention: '--on-pink',
  scrim: '--scrim',
  scrollbar_thumb: '--scrollbar-thumb',
  scrollbar_track: '--scrollbar-track',
} as const;
export type ColorRole = keyof typeof COLOR_TOKENS;
export const COLOR_ROLES = Object.keys(COLOR_TOKENS) as ColorRole[];

export const FONT_TOKENS = { display: '--f-display', body: '--f-body', mono: '--f-mono' } as const;
export type FontRole = keyof typeof FONT_TOKENS;
export const FONT_ROLES = Object.keys(FONT_TOKENS) as FontRole[];

/* Every cut corner is its usual size times this number: 0 is square, 1 the usual cut. */
export const CUT_TOKEN = '--cut-k';
export const CUT_RANGE = { min: 0, max: 1.5 };
/* How a cut corner is drawn: one slant, or two square steps as on a screen of big pixels. */
export const CUT_SHAPES = ['bevel', 'steps'] as const;
export type CutShape = (typeof CUT_SHAPES)[number];

/* The least opacity the core of a task worked on now breathes down to (Design #1628), measured per skin to keep 3:1 on the
   row, the row under the pointer and the open row. A look with none, as a person's own skin, keeps it at 1: still. */
export const PULSE_TOKEN = '--tracker-pulse-low';

/* Whether a skin is dark or light, which tells the browser how to draw its own parts: scrollbars, fields, checkboxes. */
export const SCHEMES = ['dark', 'light'] as const;
export type Scheme = (typeof SCHEMES)[number];

/* Whether a skin keeps the standard schematic map or renders an interactive world map and interior scenes: 'standard',
   or the id of a world pack, shipped or installed from a theme archive. */
export const WORLD_KINDS = ['standard', 'egypt'] as const;
export type WorldKind = (typeof WORLD_KINDS)[number] | (string & {});

/* Visual surface treatment applied across screens over the semantic tokens without changing layout geometry. */
export const SURFACE_STYLES = ['plain', 'papyrus'] as const;
export type SurfaceStyle = (typeof SURFACE_STYLES)[number];

/* Shared world map colour roles for interactive world themes; non-world themes leave them unset. */
export const WORLD_COLOR_TOKENS = {
  ground: '--world-ground',
  path: '--world-path',
  field: '--world-field',
  water: '--world-water',
  structure: '--world-structure',
  shade: '--world-shade',
} as const;
export type WorldColorRole = keyof typeof WORLD_COLOR_TOKENS;
export const WORLD_COLOR_ROLES = Object.keys(WORLD_COLOR_TOKENS) as WorldColorRole[];
export type WorldColors = Readonly<Record<WorldColorRole, string>>;
export const WORLD_PROPERTIES = Object.values(WORLD_COLOR_TOKENS);

/* Optional dark terminal overrides for themes that adjust the terminal surface, ink and ANSI palette. */
export const TERMINAL_TOKENS = { bg: '--term-bg', ink: '--term-ink' } as const;
export type SkinTerminal = Readonly<{
  bg: string;
  ink: string;
  cursor?: string;
  cursorAccent?: string;
  selection?: string;
  selectionInk?: string;
  idle?: string;
  ansi?: readonly string[];
}>;
export const TERMINAL_PROPERTIES = Object.values(TERMINAL_TOKENS);

export type SkinColors = Readonly<Record<ColorRole, string>>;
type SkinFonts = Readonly<Record<FontRole, readonly string[]>>;
export type SkinLook = {
  scheme: Scheme;
  colors: SkinColors;
  fonts: SkinFonts;
  cut: number;
  shape: CutShape;
  pulse?: number;
  world?: WorldKind;
  surface?: SurfaceStyle;
  worldColors?: WorldColors;
  terminal?: SkinTerminal;
};
/* The name of a person's own skin in each language Hornhoof speaks. */
export type SkinNames = Readonly<{ ru: string; en: string }>;
/* A skin of a person's own, as its file holds it: the built-in skin it stands on, which gives it the shape of its cut,
   its names, and the values it sets. */
export type Skin = { base: string; name: SkinNames; scheme: Scheme; colors: SkinColors; fonts: SkinFonts; cut: number };

/* Families a browser knows by a keyword: they go out without quotes, and a font list always ends with one. */
export const GENERIC_FONTS = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'];
/* Keywords of system fonts that work only without quotes; a list never ends with one. */
const SYSTEM_FONTS = ['-apple-system', 'BlinkMacSystemFont'];

const isKeyword = (font: string) => GENERIC_FONTS.includes(font) || SYSTEM_FONTS.includes(font);
const fontStack = (fonts: readonly string[]) => fonts.map(font => (isKeyword(font) ? font : `'${font}'`)).join(', ');

/* The tokens a skin sets on the page, every one of them, so no value of the skin before it stays behind. */
export function declarations(look: SkinLook): [string, string][] {
  const colors = COLOR_ROLES.map((role): [string, string] => [COLOR_TOKENS[role], look.colors[role]]);
  const fonts = FONT_ROLES.map((role): [string, string] => [FONT_TOKENS[role], fontStack(look.fonts[role])]);
  return [...colors, ...fonts, [CUT_TOKEN, String(look.cut)], [PULSE_TOKEN, String(look.pulse ?? 1)], ['color-scheme', look.scheme]];
}

/* Optional world and terminal tokens a skin adds, paired with the keys to clear when switching back to a plain skin. */
export function extraDeclarations(look: SkinLook): { set: [string, string][]; clear: string[] } {
  const set: [string, string][] = [];
  const clear: string[] = [];
  if (look.worldColors) {
    for (const role of WORLD_COLOR_ROLES) set.push([WORLD_COLOR_TOKENS[role], look.worldColors[role]]);
  } else {
    clear.push(...WORLD_PROPERTIES);
  }
  if (look.terminal) {
    set.push([TERMINAL_TOKENS.bg, look.terminal.bg], [TERMINAL_TOKENS.ink, look.terminal.ink]);
  } else {
    clear.push(...TERMINAL_PROPERTIES);
  }
  return { set, clear };
}

export const SKIN_PROPERTIES = [...Object.values(COLOR_TOKENS), ...Object.values(FONT_TOKENS), CUT_TOKEN, PULSE_TOKEN, 'color-scheme'];
