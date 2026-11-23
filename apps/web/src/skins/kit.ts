import { THEME_KIT_COLORS, THEME_KIT_SLOTS, THEME_KIT_VALUE_LENGTH, THEME_KIT_VALUES, THEME_LIMITS } from '@hornhoof/protocol/themes';

/* A theme's painted interface parts (its ui/kit.json, #1960) put on the page as the CSS variables kit.css draws from
   (theme UI kit 1.0, sections 3 and 6.2): per slot --kit-<slot> (the picture), --kit-<slot>-slice, -width, -outset,
   -repeat and -size, and --kit-<slot>-bg: transparent when the slot paints the element's whole face; per kit colour
   --kit-c-<name>. The slots painted whole are named in data-kit-faces, so kit.css can take the square fill off their
   elements. The server checked the kit when it took the archive; every name and value is checked again here against the
   same lists and forms, so none can reach CSS as anything but a picture of the theme, a length, a keyword or a colour. */

const MEASURES = ['slice', 'width', 'outset', 'repeat', 'size'] as const;
type Measure = (typeof MEASURES)[number];

export type KitSlot = Partial<Record<Measure, string>> & { file: string };
export type Kit = { slots: Record<string, KitSlot>; colors?: Record<string, string> };

const SLOTS: ReadonlySet<string> = new Set(THEME_KIT_SLOTS);
const COLORS: ReadonlySet<string> = new Set(THEME_KIT_COLORS);
/* The theme's own files on this server: /api/themes/files/<theme>/<version>/. */
const BASE = /^\/api\/themes\/files\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}\/)[A-Za-z0-9._+-]+\/$/;

const fitsFile = (file: unknown): file is string =>
  typeof file === 'string' && file.length <= THEME_LIMITS.pathLength && THEME_KIT_VALUES.file.test(file);
const fitsValue = (measure: Measure, value: unknown): value is string =>
  typeof value === 'string' && value.length <= THEME_KIT_VALUE_LENGTH && THEME_KIT_VALUES[measure].test(value);

type Declared = { set: [string, string][]; faces: string[] };

function declarations(kit: Kit, base: string): Declared {
  const set: [string, string][] = [];
  const faces: string[] = [];
  for (const [name, slot] of Object.entries(kit.slots ?? {})) {
    if (!SLOTS.has(name) || !slot || !fitsFile(slot.file)) continue;
    set.push([`--kit-${name}`, `url("${base}ui/kit/${encodeURIComponent(slot.file)}")`]);
    for (const measure of MEASURES) if (fitsValue(measure, slot[measure])) set.push([`--kit-${name}-${measure}`, slot[measure]!]);
    /* A part painted with its middle ("fill" in its slice) is the element's whole face, so its own fill steps aside. */
    if (fitsValue('slice', slot.slice) && slot.slice.endsWith(' fill')) {
      set.push([`--kit-${name}-bg`, 'transparent']);
      faces.push(name);
    }
  }
  for (const [name, color] of Object.entries(kit.colors ?? {})) {
    if (COLORS.has(name) && typeof color === 'string' && THEME_KIT_VALUES.color.test(color)) set.push([`--kit-c-${name}`, color]);
  }
  return { set, faces };
}

/* Puts the active theme's kit on the page in place of the last one, or takes every trace of a kit away when the theme has
   none or its pictures would come from anywhere but the theme's files on this server. */
export function applyKit(page: HTMLElement, kit: Kit | null, base: string): void {
  for (const property of [...page.style].filter(name => name.startsWith('--kit-'))) page.style.removeProperty(property);
  delete page.dataset.kitFaces;
  const { set, faces } = kit && BASE.test(base) ? declarations(kit, base) : { set: [], faces: [] };
  if (!set.length) {
    delete page.dataset.kit;
    return;
  }
  for (const [property, value] of set) page.style.setProperty(property, value);
  if (faces.length) page.dataset.kitFaces = faces.join(' ');
  page.dataset.kit = 'on';
}
