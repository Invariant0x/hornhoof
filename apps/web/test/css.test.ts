import { expect, it } from 'vitest';
import { decl, parse, px, RULES, rulesFor } from './css';

function paddingRightPx(selector: string): number | undefined {
  const right = decl(selector, 'padding-right');
  if (right) return px(right);
  const pad = decl(selector, 'padding');
  if (!pad) return undefined;
  const parts = pad.trim().split(/\s+/);
  return px(parts.length === 1 ? parts[0] : parts[1]);
}

it('reads container rules with the same condition as media rules', () => {
  expect(parse('@container card (min-width: 700px) { .blocks { display: grid; } }', null)).toEqual([
    { media: 'card (min-width: 700px)', selectors: ['.blocks'], decls: { display: 'grid' } },
  ]);
});

it('gives every select a shared theme-colored arrow inset from the right edge and room for text', () => {
  expect(decl('select', 'appearance')).toBe('none');
  expect(decl('select', 'max-width')).toBe('100%');
  expect(decl('select', 'min-width')).toBe('0');
  expect(decl('select', 'overflow')).toBe('hidden');
  expect(decl('select', 'text-overflow')).toBe('ellipsis');
  expect(decl('select', 'white-space')).toBe('nowrap');
  expect(decl('select', 'background-image')).toMatch(/var\(--/);
  expect(decl('select', 'background-position')).toContain('50%');
  expect(decl('select', 'background-repeat')).toBe('no-repeat');
  expect(paddingRightPx('select')).toBeGreaterThanOrEqual(26);
  expect(decl('select:disabled', 'opacity')).toBe('.55');
  expect(decl('.field', 'min-width')).toBe('0');
  expect(decl('.field select', 'width')).toBe('100%');

  for (const sel of ['.field select', '.share select', '.staff-pick select', '.sel']) {
    for (const rule of rulesFor(sel)) {
      expect(rule.decls.background, `${sel} must not reset the select arrow with shorthand background`).toBeUndefined();
    }
    const right = paddingRightPx(sel) ?? paddingRightPx('select')!;
    expect(right, `${sel} must keep right padding for the arrow`).toBeGreaterThanOrEqual(26);
  }
});

it("paints what an agent does from the theme's tokens, and an alarm and the frame around it in the theme's danger", () => {
  expect(decl('.ast', 'color')).toBe('var(--muted)');
  expect(decl('.ast.work', 'color')).toBe('var(--cyan-ink)');
  expect(decl('.ast.person', 'color')).toBe('var(--pink-ink)');
  expect(decl('.ast.alarm', 'background')).toBe('var(--red)');
  expect(decl('.ast.alarm', 'color')).toBe('var(--on-red)');
  for (const frame of ['.schip:has(.ast.alarm) > .edge', '.shead:has(.ast.alarm) > .edge', '.tview .lchip:has(.ast.alarm)']) expect(decl(frame, 'background')).toBe('var(--red)');
  /* The tree's shared fixed-size Chip keeps the state badge visible and clips only long text on its single status line. */
  expect(decl('.tview .tv-labs .dept-chip', 'position')).toBe('absolute');
  expect(decl('.ast', 'flex')).toBe('none');
  expect(decl('.ast', 'white-space')).toBe('nowrap');
  expect(decl('.schip .r3 .ast', 'margin-right')).toBe('6px');
  expect(decl('.schip .r3', 'white-space')).toBe('nowrap');
  expect(decl('.schip .r3', 'overflow')).toBe('hidden');
  expect(decl('.schip .r3', 'text-overflow')).toBe('ellipsis');
});

it('wraps question materials and keeps their viewer and actions inside the available width', () => {
  for (const selector of ['.mat-zone', '.mat-list', '.mat-row', '.mat-text', '.opts', '.opt', '.mv', '.mv-stage', '.mv-doc', '.mv-pdf', '.mv-page', '.mv-nav', '.mv-zoom']) {
    expect(decl(selector, 'min-width'), selector).toBe('0');
  }
  expect(decl('.mat', 'grid-template-columns')).toBe('64px minmax(0, 1fr)');
  expect(decl('.mat', 'inline-size')).toBe('100%');
  expect(decl('.mat-name', 'overflow-wrap')).toBe('anywhere');
  expect(decl('.mat-large .mat-thumb', 'inline-size')).toBe('100%');
  expect(decl('.mat-large .mat-thumb', 'aspect-ratio')).toBe('16 / 10');
  expect(decl('.opts', 'grid-template-columns')).toBe('repeat(auto-fit, minmax(min(100%, 280px), 1fr))');
  expect(decl('.choice-list > .req-option', 'min-height')).toBe('44px');
  expect(decl('.entry-actions', 'flex-wrap')).toBe('wrap');
  expect(decl('.entry-actions', 'inline-size')).toBe('100%');
  expect(decl('.entry-actions > :is(.act, .btn)', 'min-inline-size')).toBe('0');
  expect(decl('.entry-actions > :is(.act, .btn)', 'max-inline-size')).toBe('100%');
  expect(decl('.entry-actions > :is(.act, .btn)', 'white-space')).toBe('normal');
  expect(decl('.mv-back', 'position')).toBe('fixed');
  expect(decl('.mv-back', 'inset')).toBe('0');
  expect(decl('.mv', 'grid-template-rows')).toBe('auto minmax(0, 1fr) auto');
  expect(decl('.mv-stage', 'overflow')).toBe('auto');
  expect(decl('.mv-pic.fit', 'grid-template')).toBe('minmax(0, 1fr) / minmax(0, 1fr)');
  expect(decl('.mv-doc', 'max-inline-size')).toBe('760px');
  expect(decl('.mv-plain', 'overflow-wrap')).toBe('anywhere');
  expect(decl('.mv-acts > .act', 'min-height')).toBe('44px');
});

it('draws every focus ring in the accent ink, which keeps 3:1 on every surface of every theme', () => {
  const rings = RULES.filter(r => r.selectors.some(s => s.includes(':focus-visible')) && r.decls.outline && r.decls.outline !== 'none');
  expect(rings.map(r => r.selectors.join(', '))).toEqual(expect.arrayContaining([':focus-visible', '.segments label:has(input:focus-visible)', '.seg button:focus-visible', 'button.hub:focus-visible', '.t-mh:focus-visible']));
  for (const ring of rings) expect(ring.decls.outline, ring.selectors.join(', ')).toMatch(/^2px solid var\(--cyan-ink\)$/);
});

it('lets a finger take a line of the company map and a bend on it as easily as a block\'s grip', () => {
  /* In the map's own units, against its zoom: a browser finds what a pointer is on without vector-effect, by the drawn width. */
  expect(decl('.wires .hit', 'stroke-width')).toBe('calc(12px / var(--k, 1))');
  expect(decl('.wires .hit', 'stroke-width', '(pointer: coarse)')).toBe('calc(24px / var(--k, 1))');
  expect(decl('.wires .hit', 'vector-effect')).toBeUndefined();
  /* A phone flashes nothing over the map where a finger touches a line or a bend: neither is drawn. */
  expect(decl('.wires .hit', '-webkit-tap-highlight-color')).toBe('transparent');
  expect(decl('.bend', '-webkit-tap-highlight-color')).toBe('transparent');
  expect(['width', 'height', 'margin'].map(p => decl('.bend', p))).toEqual(['28px', '28px', '-14px 0 0 -14px']);
  expect(['width', 'height', 'margin'].map(p => decl('.bend', p, '(pointer: coarse)'))).toEqual(['44px', '44px', '-22px 0 0 -22px']);
});

it("sets the Machines pool's and card's percentages in the text font at the size and weight of the figure beside them", () => {
  expect(decl('.pool-facts .pct', 'font-family')).toBe('var(--f-body)');
  expect(decl('.g-f .pct', 'font-family')).toBe('var(--f-body)');
  expect(decl('.pool-facts .pct', 'font-variant-numeric')).toBe('tabular-nums');
  expect(decl('.g-f .pct', 'font-variant-numeric')).toBe('tabular-nums');
  for (const selector of ['.pool-facts .pct', '.g-f .pct']) {
    expect(decl(selector, 'font-size')).toBeUndefined();
    expect(decl(selector, 'font-weight')).toBeUndefined();
    expect(decl(selector, 'font')).toBeUndefined();
  }
  expect(decl('.pool-facts dd', 'font-family')).toBe('var(--f-display)');
  expect(decl('.g-f b', 'font-family')).toBe('var(--f-display)');
  /* The small muted unit beside a meter's figure is its own child; a share inside the figure keeps the figure's size. */
  expect(rulesFor('.g-f span')).toEqual([]);
  expect(decl('.g-f > span', 'font-size')).toBe('12.5px');
  expect(decl('.g-f > span', 'color')).toBe('var(--muted)');
});
