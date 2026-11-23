/* A theme's painted interface parts (its ui/kit.json, #1960) put on the page as the CSS variables kit.css draws from:
   per slot --kit-<slot> (the picture), --kit-<slot>-slice, -width, -outset and -size, and --kit-<slot>-bg: transparent when
   the slot paints the element's whole face; per kit colour --kit-c-<name>. The server checked the kit when it took the
   archive; every value is checked again here, so none can reach CSS as anything but a picture of the theme, a length or a
   colour. */

export type KitSlot = { file: string; slice?: string; width?: string; outset?: string; size?: string };
export type Kit = { slots: Record<string, KitSlot>; colors?: Record<string, string> };

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE = /^[A-Za-z0-9._@-]+\.(?:png|webp|svg)$/;
const SLICE = /^(?:\d{1,4}(?:\s+|$)){1,4}(?:fill)?$/;
const LENGTHS = /^(?:(?:\d{1,4}(?:\.\d{1,3})?(?:px|%)|0|auto)(?:\s+|$)){1,4}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
/* The theme's own files on this server: /api/themes/files/<theme>/<version>/. */
const BASE = /^\/api\/themes\/files\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}\/)[A-Za-z0-9._+-]+\/$/;

const MEASURES = ['slice', 'width', 'outset', 'size'] as const;

const fits = (slot: KitSlot): boolean =>
  FILE.test(slot.file) && (slot.slice === undefined || SLICE.test(slot.slice))
  && [slot.width, slot.outset, slot.size].every(value => value === undefined || LENGTHS.test(value));

function declarations(kit: Kit, base: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, slot] of Object.entries(kit.slots)) {
    if (!NAME.test(name) || !slot || typeof slot.file !== 'string' || !fits(slot)) continue;
    out.push([`--kit-${name}`, `url("${base}ui/kit/${encodeURIComponent(slot.file)}")`]);
    for (const measure of MEASURES) if (slot[measure] !== undefined) out.push([`--kit-${name}-${measure}`, slot[measure]!.trim()]);
    if (slot.slice?.trim().endsWith('fill')) out.push([`--kit-${name}-bg`, 'transparent']);
  }
  for (const [name, color] of Object.entries(kit.colors ?? {})) if (NAME.test(name) && COLOR.test(color)) out.push([`--kit-c-${name}`, color]);
  return out;
}

/* Puts the active theme's kit on the page in place of the last one, or takes every trace of a kit away when the theme has
   none or its pictures would come from anywhere but the theme's files on this server. */
export function applyKit(page: HTMLElement, kit: Kit | null, base: string): void {
  for (const property of [...page.style].filter(name => name.startsWith('--kit-'))) page.style.removeProperty(property);
  const set = kit && BASE.test(base) ? declarations(kit, base) : [];
  if (!set.length) {
    delete page.dataset.kit;
    return;
  }
  for (const [property, value] of set) page.style.setProperty(property, value);
  page.dataset.kit = 'on';
}
