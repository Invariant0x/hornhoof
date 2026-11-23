import type { FontRole, Skin, SkinLook } from './roles';

/* The built-in skins, each a whole look of its own, in the order the Themes section shows them. A new skin is one more
   entry here and its name and description in each language of i18n: no screen changes. Cyberpunk comes first and is on
   until a person picks another; theme.css keeps none of the skin values. */

/* The fonts of most skins. One set for them keeps text and blocks in place when the skin changes. */
const FONTS: Record<FontRole, readonly string[]> = {
  display: ['Tektur', 'Onest', 'system-ui', 'sans-serif'],
  body: ['Onest', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
};

/* Handjet, an open dotted font with Latin and Cyrillic kept in src/fonts with its licence, for headings and buttons only:
   it is too narrow for long text, which stays in Onest. */
const PIXEL_FONTS: Record<FontRole, readonly string[]> = { ...FONTS, display: ['Handjet', 'Onest', 'system-ui', 'sans-serif'] };

/* Alegreya and Golos Text, open fonts with Latin and Cyrillic kept in src/fonts with their OFL licences. Scripts outside
   their unicode-range (such as Arabic) fall through to system-ui. */
const EGYPT_FONTS: Record<FontRole, readonly string[]> = {
  display: ['Alegreya', 'Golos Text', 'Georgia', 'system-ui', 'serif'],
  body: ['Golos Text', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
};

export const BUILTIN_SKINS = [
  /* The native dark look: blue-black panels, a cyan accent, cut corners. */
  {
    id: 'cyberpunk',
    scheme: 'dark',
    cut: 1,
    shape: 'bevel',
    pulse: .55,
    fonts: FONTS,
    colors: {
      bg: '#141A22', surface: '#1B232D', surface2: '#212B37', line: '#2C3845', line2: '#687A8F', ink: '#E3EAF1', muted: '#93A0AE',
      accent: '#46E0EF', accent_ink: '#6FE9F5', warning: '#FFB54A', warning_ink: '#FFC36E', attention: '#FF62AA', attention_ink: '#FF8CC2',
      success: '#5FD08A', danger: '#FF6B6B', on_danger: '#2A0606', idle: '#2C3744', dot: 'rgba(140, 175, 205, .15)', glow: 'rgba(70, 224, 239, .10)',
      button: '#46E0EF', on_button: '#05222A', hud: 'rgba(23, 30, 39, .94)', shadow: 'rgba(0, 0, 0, .45)',
      provider_claude: '#F08A66', provider_kimi: '#5E9BFF', provider_glm: '#8D95FF', provider_antigravity: '#6DD58C',
      on_attention: '#141A22', scrim: 'rgba(10, 20, 30, .35)', scrollbar_thumb: '#687A8F', scrollbar_track: '#1B232D',
    },
  },
  /* Day light with text and lines held to their contrast on every surface. */
  {
    id: 'light',
    scheme: 'light',
    cut: 1,
    shape: 'bevel',
    pulse: .8,
    fonts: FONTS,
    colors: {
      bg: '#E6EBF0', surface: '#F8FAFC', surface2: '#EEF2F6', line: '#C9D3DD', line2: '#768695', ink: '#0F1B27', muted: '#4C5A68',
      accent: '#00A3BD', accent_ink: '#006E80', warning: '#E08A00', warning_ink: '#9A5A00', attention: '#E0307F', attention_ink: '#B0185F',
      success: '#13753D', danger: '#C62828', on_danger: '#FFFFFF', idle: '#C5D0DB', dot: 'rgba(30, 60, 90, .17)', glow: 'rgba(0, 163, 189, .10)',
      button: '#00768A', on_button: '#FFFFFF', hud: 'rgba(240, 244, 247, .94)', shadow: 'rgba(20, 40, 60, .18)',
      provider_claude: '#A84628', provider_kimi: '#125BC7', provider_glm: '#3D47D6', provider_antigravity: '#157331',
      on_attention: '#000000', scrim: 'rgba(10, 20, 30, .35)', scrollbar_thumb: '#768695', scrollbar_track: '#F8FAFC',
    },
  },
  /* Phosphor green on near black, square frames. Roles leave green so they stay apart: success jade, warning amber. */
  {
    id: 'matrix',
    scheme: 'dark',
    cut: 0,
    shape: 'bevel',
    pulse: .55,
    fonts: FONTS,
    colors: {
      bg: '#050A06', surface: '#0A130D', surface2: '#101D14', line: '#1E3525', line2: '#4A7856', ink: '#D4F7DC', muted: '#84B390',
      accent: '#00E05A', accent_ink: '#66FF99', warning: '#E5B82E', warning_ink: '#F5CD56', attention: '#F25C9A', attention_ink: '#FF8AB8',
      success: '#42DEC2', danger: '#FF5247', on_danger: '#260402', idle: '#1B3021', dot: 'rgba(82, 224, 128, .16)', glow: 'rgba(0, 224, 90, .14)',
      button: '#00E05A', on_button: '#021C0B', hud: 'rgba(8, 16, 11, .94)', shadow: 'rgba(0, 0, 0, .62)',
      provider_claude: '#F08A66', provider_kimi: '#639EFF', provider_glm: '#8F97FF', provider_antigravity: '#6EE08E',
      on_attention: '#24030A', scrim: 'rgba(2, 6, 3, .64)', scrollbar_thumb: '#4A7856', scrollbar_track: '#0A130D',
    },
  },
  /* A warm retro console: cream text on night violet, a yellow accent, dotted letters in headings and buttons, and
     corners cut in two square steps. */
  {
    id: 'pixel',
    scheme: 'dark',
    cut: 1,
    shape: 'steps',
    pulse: .55,
    fonts: PIXEL_FONTS,
    colors: {
      bg: '#151523', surface: '#202033', surface2: '#2A2A40', line: '#42425C', line2: '#9292AD', ink: '#FFF4DA', muted: '#C9BFAC',
      accent: '#FFD166', accent_ink: '#FFE09A', warning: '#FFAD66', warning_ink: '#FFCC99', attention: '#E99EFF', attention_ink: '#F1C3FF',
      success: '#86E8AF', danger: '#FF9790', on_danger: '#281414', idle: '#45455D', dot: 'rgba(255, 209, 102, .12)', glow: 'rgba(255, 209, 102, .10)',
      button: '#FFD166', on_button: '#252018', hud: 'rgba(26, 26, 43, .94)', shadow: 'rgba(0, 0, 0, .50)',
      provider_claude: '#F6A382', provider_kimi: '#91BFFF', provider_glm: '#B2ACFF', provider_antigravity: '#8CE7A4',
      on_attention: '#26172C', scrim: 'rgba(8, 8, 18, .64)', scrollbar_thumb: '#9292AD', scrollbar_track: '#202033',
    },
  },
  /* Sunlit desert sandstone, woven papyrus panels, royal lapis accents and an interactive isometric Egypt map. */
  {
    id: 'egypt',
    scheme: 'light',
    cut: 1,
    shape: 'bevel',
    pulse: .8,
    world: 'egypt',
    surface: 'papyrus',
    fonts: EGYPT_FONTS,
    colors: {
      bg: '#E6D9BE', surface: '#FAF4E6', surface2: '#F1E6D2', line: '#D2C2A5', line2: '#806F57', ink: '#221A12', muted: '#554736',
      accent: '#1A5A8F', accent_ink: '#124270', warning: '#9E6A00', warning_ink: '#6F4900', attention: '#A3245B', attention_ink: '#851B48',
      success: '#0D6748', danger: '#AD1D14', on_danger: '#FAF4E6', idle: '#CCBFA3', dot: 'rgba(92, 74, 48, .18)', glow: 'rgba(26, 90, 143, .11)',
      button: '#154B7D', on_button: '#FAF4E6', hud: 'rgba(248, 241, 226, .94)', shadow: 'rgba(42, 31, 18, .18)',
      provider_claude: '#9C3B1D', provider_kimi: '#1454BF', provider_glm: '#3A40BD', provider_antigravity: '#11652B',
      on_attention: '#FAF4E6', scrim: 'rgba(34, 26, 18, .38)', scrollbar_thumb: '#806F57', scrollbar_track: '#FAF4E6',
    },
    worldColors: {
      ground: '#E4D1AA',
      path: '#C6A46D',
      field: '#7E9A54',
      water: '#2B6E9B',
      structure: '#D7BE92',
      shade: 'rgba(42, 31, 18, .28)',
    },
    terminal: {
      bg: '#17130F',
      ink: '#EFE4CE',
      cursor: '#E6B34C',
      cursorAccent: '#1A130B',
      selection: '#5CA4E8',
      selectionInk: '#0E1722',
      idle: '#332A21',
      ansi: [
        '#1D1712', '#F07067', '#5ED69E', '#E6B74C', '#6EB0FA', '#EC83B0', '#56D6D2', '#E5D8C0',
        '#A69680', '#FF9890', '#8AE8BC', '#FAD375', '#9AC9FF', '#F7A8CB', '#8CE8E5', '#FAF4E6',
      ],
    },
  },
] as const satisfies readonly (SkinLook & { id: string })[];

export type BuiltinSkinId = (typeof BUILTIN_SKINS)[number]['id'];
export type BuiltinSkin = SkinLook & { readonly id: BuiltinSkinId };
export const DEFAULT_SKIN: BuiltinSkinId = 'cyberpunk';

/* The built-in skin of this name; a name of anything else, such as a key of every object, finds none. */
export const builtinSkin = (id: string): BuiltinSkin | undefined => BUILTIN_SKINS.find(skin => skin.id === id);

/* The look of a person's own skin: its values, and the shape of the cut of the built-in skin it stands on. */
export const ownLook = ({ scheme, colors, fonts, cut, base }: Skin): SkinLook => ({ scheme, colors, fonts, cut, shape: builtinSkin(base)?.shape ?? 'bevel' });

/* The fonts Hornhoof carries itself; any other font shows only where the device has it. */
export const SHIPPED_FONTS = ['Onest', 'Tektur', 'Handjet', 'Alegreya', 'Golos Text'];
