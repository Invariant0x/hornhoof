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

it('draws the glow and the focus ring of a framed button in the shape of its frame, with no square shadow or outline around it', () => {
  /* The glow is a shadow of a copy of the frame's shape, cut as the frame is, in steps where the skin cuts in steps. */
  expect(decl('.halo-glow > i', 'clip-path')).toBe(decl('.edge', 'clip-path'));
  expect(decl(":where(:root[data-cut='steps']) .halo-glow > i", 'clip-path')).toBe(decl(":where(:root[data-cut='steps']) .edge", 'clip-path'));
  expect(decl('.halo-glow', 'filter')).toBe('drop-shadow(0 0 calc(var(--halo-blur) / 2) color-mix(in srgb, var(--glow) 45%, transparent))');
  expect(decl('.halo', '--halo-blur')).toBe('12px');
  const glowing = ':is(button.dept.busy, button.dept.waits, button.chip-btn.attn) > .halo > .halo-glow';
  expect(decl(glowing, 'animation')).toBe('dglow 2.6s ease-in-out infinite');
  expect(decl(glowing, 'display', '(prefers-reduced-motion: reduce)')).toBe('none');
  /* The ring is the frame's shape 2 px out and 2 px wide in the accent ink, in place of the square outline. */
  expect(decl('.halo', '--ring')).toBe('2px');
  expect(decl('.halo', '--ring-gap')).toBe('2px');
  expect(decl('.halo-ring', 'inset')).toBe('calc(-1 * (var(--ring-gap) + var(--ring)))');
  expect(decl('.halo-ring', 'background')).toBe('var(--cyan-ink)');
  expect(decl('.halo-ring', 'background', '(forced-colors: active)')).toBe('Highlight');
  expect(decl(':focus-visible > .halo > .halo-ring', 'display')).toBe('block');
  expect(decl(':focus-visible:has(> .halo)', 'outline')).toBe('none');
  /* No square shadow or outline is left on a button that shows a frame. */
  const square = RULES.filter(r => r.selectors.some(s => /^(button\.dept|button\.chip-btn|button\.shead|button\.schip|\.run-open)\b/.test(s)) && (r.decls['box-shadow'] || r.decls.outline));
  expect(square.map(r => r.selectors.join(', '))).toEqual([]);
});

it('frames every invalid field control in pink by one shared .field rule while keeping a visible focus ring', () => {
  const invalid = '.field :is(input, select, textarea)[aria-invalid="true"]';
  const focused = `${invalid}:is(:focus, :focus-visible)`;
  expect(decl(invalid, 'border-color')).toBe('var(--pink)');
  expect(decl(focused, 'border-color')).toBe('var(--pink)');
  expect(decl(focused, 'outline')).toBe('2px solid var(--cyan-ink)');
  expect(decl(focused, 'outline-offset')).toBe('2px');
  expect(decl(focused, 'box-shadow')).toBe('none');
  expect(RULES.filter(r => r.selectors.some(s => s.includes('aria-invalid'))).map(r => r.selectors)).toEqual([
    [invalid],
    [focused],
  ]);
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

it('sizes the map scale label by its content from tokens without clipping and keeps 44 px zoom buttons', () => {
  expect(decl('.zoom', 'max-inline-size')).toBe('calc(100% - 32px)');
  expect(decl('.zbtn', 'flex')).toBe('none');
  expect(decl('.zbtn', 'width')).toBe('44px');
  expect(decl('.zbtn', 'height')).toBe('44px');
  expect(decl('.zv', 'flex')).toBe('none');
  expect(decl('.zv', 'box-sizing')).toBe('border-box');
  expect(decl('.zv', 'min-inline-size')).toBe('52px');
  expect(decl('.zv', 'min-width')).toBeUndefined();
  expect(decl('.zv', 'padding-inline')).toBe('8px');
  expect(decl('.zv', 'white-space')).toBe('nowrap');
  expect(decl('.zv', 'font-family')).toBe('var(--f-body)');
  expect(decl('.zv', 'font-size')).toBe('13px');
  expect(decl('.zv', 'font-weight')).toBe('500');
  expect(decl('.zv', 'line-height')).toBe('1.45');
  expect(decl('.zv', 'font-variant-numeric')).toBe('tabular-nums');
  expect(decl('.zv', 'overflow')).toBeUndefined();
  expect(decl('.zv', 'text-overflow')).toBeUndefined();
});
