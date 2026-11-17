import type { ColorRole, SkinColors } from './roles';

/* How readable the colours of a skin are, by WCAG 2: text 4.5:1 on every surface it stands on and on its own fill,
   borders of controls 3:1. A file whose colours fail one pair is refused, and a built-in skin passes every pair. */

/* The colour forms a skin takes: #RRGGBB, or rgba() with channels 0 to 255 and an alpha from 0 to 1. */
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGBA = /^rgba\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3}), ?(0|1|0?\.\d{1,4}|1\.0{1,4})\)$/;

type Rgba = { r: number; g: number; b: number; a: number };

export function readColor(value: string): Rgba | null {
  const hex = HEX.exec(value);
  if (hex) return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 };
  const rgba = RGBA.exec(value);
  if (!rgba) return null;
  const [r, g, b, a] = rgba.slice(1).map(Number) as [number, number, number, number];
  return r <= 255 && g <= 255 && b <= 255 ? { r, g, b, a } : null;
}

const linear = (channel: number) => {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }: Rgba) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const SURFACES = ['bg', 'surface', 'surface2'] as const satisfies readonly ColorRole[];
/* Roles a screen writes text in. Accent, warning and attention are fills and lines, their *_ink twins are the text. */
const TEXT = ['ink', 'muted', 'accent_ink', 'warning_ink', 'attention_ink', 'success', 'danger', 'provider_claude', 'provider_kimi', 'provider_glm', 'provider_antigravity'] as const satisfies readonly ColorRole[];

type ContrastPair = { text: ColorRole; on: ColorRole; least: number; kind: 'text' | 'line' };

/* Every pair a skin must hold. The accent ink is also the focus ring, held here at the higher bar of text. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...TEXT.flatMap(text => SURFACES.map((on): ContrastPair => ({ text, on, least: 4.5, kind: 'text' }))),
  { text: 'on_button', on: 'button', least: 4.5, kind: 'text' },
  { text: 'on_danger', on: 'danger', least: 4.5, kind: 'text' },
  { text: 'on_attention', on: 'attention', least: 4.5, kind: 'text' },
  ...SURFACES.map((on): ContrastPair => ({ text: 'line2', on, least: 3, kind: 'line' })),
];

/* Glass is see-through: muted text on it stands on the glass over whatever the page shows under it, held here over a white
   page and over a black one. */
const GLASS_PAIR: ContrastPair = { text: 'muted', on: 'hud', least: 4.5, kind: 'text' };
const UNDER_GLASS: readonly Rgba[] = [{ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }];

/* A see-through colour as it shows over an opaque one. */
const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});

function glassHolds(colors: SkinColors): boolean {
  const text = readColor(colors[GLASS_PAIR.text]);
  const glass = readColor(colors[GLASS_PAIR.on]);
  return !!text && !!glass && UNDER_GLASS.every(under => contrast(text, over(glass, under)) >= GLASS_PAIR.least);
}

/* The first pair of these colours under its bar, compared exactly, before any rounding; null when all hold. Colours
   that cannot be read count as failing, so nothing passes unchecked. */
export function weakPair(colors: SkinColors): ContrastPair | null {
  for (const pair of CONTRAST_PAIRS) {
    const text = readColor(colors[pair.text]);
    const on = readColor(colors[pair.on]);
    if (!text || !on || contrast(text, on) < pair.least) return pair;
  }
  return glassHolds(colors) ? null : GLASS_PAIR;
}
