import { expect, it } from 'vitest';
import { decl, parse, px, rulesFor } from './css';

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
  expect(decl('.task-filters', 'min-width')).toBe('0');

  for (const sel of ['.field select', '.share select', '.staff-pick select', '.sel']) {
    for (const rule of rulesFor(sel)) {
      expect(rule.decls.background, `${sel} must not reset the select arrow with shorthand background`).toBeUndefined();
    }
    const right = paddingRightPx(sel) ?? paddingRightPx('select')!;
    expect(right, `${sel} must keep right padding for the arrow`).toBeGreaterThanOrEqual(26);
  }
});

it("paints what an agent does from the theme's tokens, and an alarm and the frame around it red, light and dark", () => {
  expect(decl('.ast', 'color')).toBe('var(--muted)');
  expect(decl('.ast.work', 'color')).toBe('var(--cyan-ink)');
  expect(decl('.ast.person', 'color')).toBe('var(--pink-ink)');
  expect(decl('.ast.alarm', 'background')).toBe('var(--red)');
  expect(decl('.ast.alarm', 'color')).toBe('var(--on-red)');
  for (const frame of ['.schip:has(.ast.alarm) > .edge', '.shead:has(.ast.alarm) > .edge', '.tview .lchip:has(.ast.alarm)']) expect(decl(frame, 'background')).toBe('var(--red)');
  const dark = '(prefers-color-scheme: dark)';
  for (const [selector, media] of [[':root', null], [':root:not([data-theme="light"])', dark], [':root[data-theme="dark"]', null]] as const) {
    expect(decl(selector, '--red', media), selector).toMatch(/^#[0-9A-F]{6}$/);
    expect(decl(selector, '--on-red', media), selector).toMatch(/^#[0-9A-F]{6}$/);
  }
  expect(decl(':root', '--red')).not.toBe(decl(':root[data-theme="dark"]', '--red'));
  /* The tree's shared fixed-size Chip keeps the state badge visible and clips only long text on its single status line. */
  expect(decl('.tview .tv-labs .dept-chip', 'position')).toBe('absolute');
  expect(decl('.ast', 'flex')).toBe('none');
  expect(decl('.ast', 'white-space')).toBe('nowrap');
  expect(decl('.schip .r3 .ast', 'margin-right')).toBe('6px');
  expect(decl('.schip .r3', 'white-space')).toBe('nowrap');
  expect(decl('.schip .r3', 'overflow')).toBe('hidden');
  expect(decl('.schip .r3', 'text-overflow')).toBe('ellipsis');
});

it('styles notebook fields and standalone panel controls with full touch geometry', () => {
  expect(decl('.notebook textarea', 'border')).toBe('1px solid var(--line2)');
  expect(decl('.notebook textarea', 'background')).toBe('var(--surface2)');
  expect(decl('.notebook textarea', 'color')).toBe('var(--ink)');
  expect(decl('.notebook textarea', 'border-radius')).toBe('0');
  expect(decl('.notebook textarea', 'padding')).toBe('8px 12px');
  expect(decl('.notebook textarea::placeholder', 'color')).toBe('var(--muted)');
  expect(decl('.notebook textarea::placeholder', 'opacity')).toBe('1');
  expect(decl('.command', 'grid-template-columns')).toBe('minmax(0, 1fr)');
  expect(decl('.command > .btn', 'justify-self')).toBe('end');
  expect(decl('.command > .btn', 'min-height')).toBe('44px');
  expect(decl('.settings-link > .btn', 'justify-self')).toBe('end');
  expect(decl('.settings-link > .btn', 'min-height')).toBe('44px');
  expect(decl('.dialog > header .btn', 'min-height')).toBe('44px');
  expect(decl('.people-head > .btn', 'min-height')).toBe('44px');
  expect(decl('.people-head > .btn', 'margin-inline-start')).toBe('auto');
  expect(decl('.panel .actions > .btn', 'min-height')).toBe('44px');
  expect(decl('.version-mark', 'position', '(max-width: 760px)')).toBe('static');
  expect(decl('.version-mark', 'display', '(max-width: 760px)')).toBe('block');
  expect(decl('.version-mark', 'text-align', '(max-width: 760px)')).toBe('end');
});

it('keeps people record status and labels compact and consistent', () => {
  expect(decl('.status', 'display')).toBe('inline-block');
  expect(decl('.status', 'max-inline-size')).toBe('100%');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td[data-label]', 'align-items')).toBe('baseline');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td[data-label]::before', 'font-size')).toBe('12px');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td[data-label]::before', 'font-weight')).toBe('400');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td[data-label]::before', 'color')).toBe('var(--muted)');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td.row-actions', 'margin-block-start')).toBe('4px');
  expect(decl('.fit > :is(.ptable, .dt)[data-fit="entries"] td.row-actions', 'margin-block-start', 'fit (max-width: 760px)')).toBe('2px');
});

it('aligns machine action groups and gives every action a full touch target', () => {
  expect(decl('.machine-actions', 'justify-content')).toBe('flex-end');
  expect(decl('.machine-actions .btn', 'min-height')).toBe('44px');
  expect(decl('.machine-actions .act', 'min-height')).toBe('44px');
  expect(decl('.fit > :is(.ptable, .dt):not([data-fit="entries"]) .nm b', 'overflow-wrap')).toBe('normal');
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
