import type { FontRole, SkinLook } from './roles';

/* The built-in skins, each a whole look of its own, in the order the Themes section shows them. A new skin is one more
   entry here and its name in each language of i18n: no screen changes. Cyberpunk comes first and is on until a person
   picks another. The values are the sheets of docs/hornhoof-themes.md; theme.css keeps none of them. */

/* The fonts of most skins. One set for them keeps text and blocks in place when the skin changes. */
const FONTS: Record<FontRole, readonly string[]> = {
  display: ['Tektur', 'Onest', 'system-ui', 'sans-serif'],
  body: ['Onest', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
};

/* Pixelify Sans, an open pixel font with Latin and Cyrillic, kept in src/fonts with its licence. */
const PIXEL_FONTS: Record<FontRole, readonly string[]> = {
  display: ['Pixelify Sans', 'Onest', 'system-ui', 'sans-serif'],
  body: ['Pixelify Sans', 'Onest', 'system-ui', 'sans-serif'],
  mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
};

export const BUILTIN_SKINS = [
  /* The native dark look: blue-black panels, a cyan accent, cut corners. */
  {
    id: 'cyberpunk',
    scheme: 'dark',
    cut: 1,
    fonts: FONTS,
    colors: {
      bg: '#141A22', surface: '#1B232D', surface2: '#212B37', line: '#2C3845', line2: '#687A8F', ink: '#E3EAF1', muted: '#93A0AE',
      accent: '#46E0EF', accent_ink: '#6FE9F5', warning: '#FFB54A', warning_ink: '#FFC36E', attention: '#FF62AA', attention_ink: '#FF8CC2',
      success: '#5FD08A', danger: '#FF6B6B', on_danger: '#2A0606', idle: '#2C3744', dot: 'rgba(140, 175, 205, .15)', glow: 'rgba(70, 224, 239, .10)',
      button: '#46E0EF', on_button: '#05222A', hud: 'rgba(23, 30, 39, .84)', shadow: 'rgba(0, 0, 0, .45)',
      provider_claude: '#F08A66', provider_kimi: '#5E9BFF', provider_glm: '#8D95FF', provider_antigravity: '#6DD58C',
    },
  },
  /* Day light with text and lines held to their contrast on every surface. */
  {
    id: 'light',
    scheme: 'light',
    cut: 1,
    fonts: FONTS,
    colors: {
      bg: '#E6EBF0', surface: '#F8FAFC', surface2: '#EEF2F6', line: '#C9D3DD', line2: '#768695', ink: '#0F1B27', muted: '#4C5A68',
      accent: '#00A3BD', accent_ink: '#006E80', warning: '#E08A00', warning_ink: '#9A5A00', attention: '#E0307F', attention_ink: '#B0185F',
      success: '#13753D', danger: '#C62828', on_danger: '#FFFFFF', idle: '#C5D0DB', dot: 'rgba(30, 60, 90, .17)', glow: 'rgba(0, 163, 189, .10)',
      button: '#00768A', on_button: '#FFFFFF', hud: 'rgba(240, 244, 247, .88)', shadow: 'rgba(20, 40, 60, .18)',
      provider_claude: '#A84628', provider_kimi: '#125BC7', provider_glm: '#3D47D6', provider_antigravity: '#157331',
    },
  },
  /* Phosphor green on near black, square frames. Roles leave green so they stay apart: success jade, warning amber. */
  {
    id: 'matrix',
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
  /* An 8-bit console: a night-blue screen, a few bright flat colours, square pixels and a pixel font. */
  {
    id: 'pixel',
    scheme: 'dark',
    cut: 0,
    fonts: PIXEL_FONTS,
    colors: {
      bg: '#1A1C2C', surface: '#262B44', surface2: '#2F3657', line: '#3E4770', line2: '#8B9BB4', ink: '#F4F4F4', muted: '#C2CCDB',
      accent: '#41A6F6', accent_ink: '#73EFF7', warning: '#FFCD75', warning_ink: '#FFDB9A', attention: '#FF77A8', attention_ink: '#FFA3C4',
      success: '#A7F070', danger: '#FF8A8A', on_danger: '#1A0508', idle: '#333C57', dot: 'rgba(148, 176, 194, .16)', glow: 'rgba(65, 166, 246, .14)',
      button: '#FFCD75', on_button: '#1A1C2C', hud: 'rgba(26, 28, 44, .88)', shadow: 'rgba(0, 0, 0, .6)',
      provider_claude: '#FF9A73', provider_kimi: '#73A9FF', provider_glm: '#A3A9FF', provider_antigravity: '#7BE08E',
    },
  },
  /* A night of deep violet with neon: cyan lines and links, a yellow main button, magenta for attention and its glow. */
  {
    id: 'neon',
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
] as const satisfies readonly (SkinLook & { id: string })[];

export type BuiltinSkin = (typeof BUILTIN_SKINS)[number];
export type BuiltinSkinId = BuiltinSkin['id'];
export const DEFAULT_SKIN: BuiltinSkinId = 'cyberpunk';

/* The built-in skin of this name; a name of anything else, such as a key of every object, finds none. */
export const builtinSkin = (id: string): BuiltinSkin | undefined => BUILTIN_SKINS.find(skin => skin.id === id);

/* The fonts Hornhoof carries itself; any other font shows only where the computer has it. */
export const SHIPPED_FONTS = ['Onest', 'Tektur', 'Pixelify Sans'];
