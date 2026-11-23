import { expect, it } from 'vitest';
import { decl, parse, px, RULES, rulesFor } from './css';

it('reserves a footer row for the version outside the screen and its fixed panels', () => {
  expect(decl('.app-layout', 'display')).toBe('grid');
  expect(decl('.app-layout', 'grid-template-rows')).toBe('minmax(0, 1fr) auto');
  expect(decl('.app-screen', 'contain')).toBe('paint');
  expect(rulesFor('.version-mark').filter(rule => ['fixed', 'absolute', 'sticky'].includes(rule.decls.position ?? ''))).toEqual([]);
});

/* The footer's row is taken from the screen above it, so a footer that comes and goes moves every window and panel fixed
   there: it hides only for a whole screen, never because a form or a panel opened in one (#1384). The map shows the version
   over its own corner instead (#1590). */
it('hides the version footer only for a whole screen, the map or a phone', () => {
  const hiding = RULES.filter(rule => rule.decls.display === 'none').flatMap(rule =>
    rule.selectors.filter(selector => selector.endsWith('.version-mark')).map(selector => `${rule.media ?? 'any width'}: ${selector}`));
  expect(hiding).toEqual([
    'any width: .app-layout:has(.map-version) > .version-mark',
    'any width: body:has(.dview) .version-mark',
    '(max-width: 760px): .version-mark',
  ]);
});

/* Over the map the version is small muted text in the bottom end corner of the room its bars leave free, mirrored right to
   left, with nothing around it, and a tap goes through it to the map (#1590). The map's bars stand at the start and in the
   middle in either direction, so none stands in that corner to raise it over (#1622). */
it('floats the version over the end corner of the map, out of the way of taps', () => {
  const rules = rulesFor('.map-version');
  expect(rules.map(rule => rule.media)).toEqual([null]);
  expect(rules[0]!.decls).toEqual({
    position: 'absolute', 'inset-block-end': '4px', 'inset-inline-end': '12px', margin: '0', color: 'var(--muted)', 'font-size': '12px',
    'pointer-events': 'none', 'user-select': 'none',
  });
});

/* The zoom of the map, the department, its tree and the tracker's graph, and the map's Put back over it, stand at the start
   of the bottom, so a page right to left mirrors them as it mirrors the rest of the layout; left to right they stay where they
   stood (#1622, #1658, #1670). */
it("stands the canvases' zoom and the map's Put back at the start of the bottom, mirrored right to left", () => {
  expect(decl('.zoom', 'inset-inline-start')).toBe('16px');
  expect(decl('.zoom', 'left')).toBeUndefined();
  expect(rulesFor('.map > .zoom')).toEqual([]);
  /* The tracker's graph is mirrored too, its root at the start, so its zoom has no place of its own any more. */
  expect(rulesFor('.tr-canvas > .zoom')).toEqual([]);
  expect(decl('.map-arrange', 'inset-inline-start')).toBe('16px');
  expect(decl('.map-arrange', 'left')).toBeUndefined();
});

/* The department's line of what happened and its actions follow the zoom along the bottom, and its drawer opens at the start
   under its name, all mirrored right to left; an agent window keeps its own place, at the left as before (#1658). */
it("mirrors the department's line, actions and drawer right to left, and leaves a window's place alone", () => {
  expect(decl('.dview .ticker', 'inset-inline')).toBe('212px var(--ticker-right, 16px)');
  expect(decl('.dv-acts', 'inset-inline-end')).toBe('16px');
  expect(decl('.dv-drawer', 'inset-inline-start')).toBe('16px');
  expect(decl('.dv-drawer', 'inset-inline', '(max-width: 760px)')).toBe('16px');
  for (const [selector, media] of [['.dview .ticker', null], ['.dv-acts', null], ['.dv-drawer', null], ['.dv-drawer', '(max-width: 760px)']] as const)
    for (const side of ['left', 'right']) expect(decl(selector, side, media), `${selector} ${side}`).toBeUndefined();
  expect(decl('.acard', 'left')).toBe('16px');
  expect(decl('.acard', 'right', '(max-width: 760px)')).toBe('16px');
});

function paddingRightPx(selector: string): number | undefined {
  const right = decl(selector, 'padding-right');
  if (right) return px(right);
  const pad = decl(selector, 'padding');
  if (!pad) return undefined;
  const parts = pad.trim().split(/\s+/);
  return px(parts.length === 1 ? parts[0] : parts[1]);
}

/* A phrase isolated in its own direction (dir="auto") lines up with the side of the block it stands in, not with its own
   start: on a right to left page an English description stands right like its heading (Design #1186). One rule for every
   such phrase, with no weight of its own, so that a part that aligns its text on purpose keeps it. */
it('lines up every isolated phrase with its block through one shared rule and no narrow copies', () => {
  expect(decl(':where([dir="auto"])', 'text-align')).toBe('match-parent');
  expect(RULES.filter(r => r.decls['text-align'] === 'match-parent').map(r => [r.media, r.selectors])).toEqual([[null, [':where([dir="auto"])']]]);
});

/* The map of a department with nobody in it, on a narrow screen and right to left (Design #1201): the hint stands above the
   buttons at the bottom, across the width, and the empty head card keeps its lines at one start edge. */
it('puts the map hint above the bottom buttons on a narrow screen, across the width and wrapping by words', () => {
  const narrow = '(max-width: 760px)';
  expect(decl('.dv-empty', 'bottom', narrow)).toBe('calc(var(--tree-bottom, 228px) + 8px)');
  expect([decl('.dv-empty', 'left', narrow), decl('.dv-empty', 'right', narrow)]).toEqual(['16px', '16px']);
  expect(decl('.dv-empty', 'transform', narrow)).toBe('none');
  expect(decl('.dv-empty', 'overflow-wrap', narrow)).toBe('break-word');
  expect(decl('.shead.empty', 'text-align')).toBe('start');
});

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
  /* The tree's shared Chip keeps the state badge whole: on one line where it fits, else wrapped inside its frame, and the
     task's words wrap after it. */
  expect(decl('.tview .tv-labs .dept-chip', 'position')).toBe('absolute');
  /* #1595: a lane moves by the place that holds its chip. */
  expect(decl('.tview .tv-labs .tv-lane', 'position')).toBe('absolute');
  expect(decl('.tview .tv-labs .tv-lane', 'left')).toBe('0');
  expect(decl('.ast', 'flex')).toBe('none');
  expect(decl('.ast', 'white-space')).toBe('nowrap');
  expect(decl('.schip .r3 .ast', 'margin-right')).toBe('6px');
  expect(decl('.schip .r3 .ast', 'max-width')).toBe('100%');
  expect(decl('.schip .r3 .ast', 'white-space')).toBe('normal');
  expect(decl('.schip .r3', 'white-space')).toBeUndefined();
  expect(decl('.schip .r3', 'overflow')).toBeUndefined();
  expect(decl('.schip .r3', 'text-overflow')).toBeUndefined();
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
    ['.check-card:has([aria-invalid="true"])'],
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

it("sets the percent sign of a share on the Machines pool and on a meter in the text font at the size and weight of its figure", () => {
  expect(decl('.pool-facts .pct', 'font-family')).toBe('var(--f-body)');
  expect(decl('.g-f .pct', 'font-family')).toBe('var(--f-body)');
  /* The sign has no figures to line up; the figures beside it keep their line's font and its tabular figures. */
  expect(decl('.pool-facts .pct', 'font-variant-numeric')).toBeUndefined();
  expect(decl('.g-f .pct', 'font-variant-numeric')).toBeUndefined();
  expect(decl('.pool-facts dd', 'font-variant-numeric')).toBe('tabular-nums');
  expect(decl('.g-f b', 'font-variant-numeric')).toBe('tabular-nums');
  /* Its line is no taller than the figure's own, so the pool's tile and the meters keep their height. */
  expect(decl('.pool-facts .pct', 'line-height')).toBe('1');
  expect(decl('.g-f .pct', 'line-height')).toBe('1');
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

it('moves the held machines pool below the held table when the initial load stalls or fails on a narrow screen', () => {
  expect(decl('.machines:has(.held-table .load-fail) > .held-pool', 'order', '(max-width: 760px)')).toBe('1');
  expect(decl('.machines:has(.held-table .load-fail) > .held-pool', 'order')).toBeUndefined();
});
