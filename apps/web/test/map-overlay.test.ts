import { describe, expect, it } from 'vitest';
import { contrast, readColor } from '../src/skins/contrast';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { ColorRole } from '../src/skins/roles';
import { decl, RULES, rulesFor } from './css';

/* Design's #1635, variant A (#1639): the menu, the bars of the shell and the bottom bar are glass blocks over the map and an
   open department, and what stands under the bars moves with them. The browser check (e2e/map-overlay.spec.ts) measures the
   page; this one holds the tokens and rules the page is drawn from. */

const BARS = '.body:not(.page) > :is(.update-banner, .alert, .guard-stop)';

describe('the glass blocks of the shell over the map', () => {
  it('are the skin\'s --hud with a 1 px --line frame, no shadow and no blur, the bars of the shell too', () => {
    expect(decl('.shell', '--bar-glass')).toBe('var(--hud)');
    expect(decl('.glass', 'background')).toBe('var(--bar-glass, var(--hud))');
    expect(decl('.glass', 'border')).toBe('1px solid var(--line)');
    expect(decl(BARS, 'background')).toBe('var(--bar-glass)');
    expect(decl(BARS, 'border')).toBe('1px solid var(--line)');
    expect(decl(BARS, 'box-shadow')).toBe('none');
    expect(RULES.filter(r => Object.keys(r.decls).some(p => /backdrop-filter/.test(p)) && r.selectors.some(s => /glass|topbar|update-banner|\.alert|guard-stop/.test(s))), 'no blur under a block').toEqual([]);
  });

  it('keep --hud at .94 in every built-in skin', () => {
    for (const skin of BUILTIN_SKINS) expect(readColor(skin.colors.hud)?.a, skin.id).toBe(0.94);
  });

  it('stand the chosen tab on an opaque backing: --glow over --surface', () => {
    expect(decl('.tabs button.on', 'background')).toBe('linear-gradient(var(--glow), var(--glow)) var(--surface)');
  });

  /* Design's table: every text on a block holds 4.5:1 against the block over the worst of what may pass under it, and the
     chosen tab's ink against its backing. */
  it('keep every text on a block readable over whatever passes under it, in every built-in skin', () => {
    type Rgb = { r: number; g: number; b: number; a: number };
    const over = (top: Rgb, under: Rgb): Rgb => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const UNDER: ColorRole[] = ['bg', 'surface', 'surface2', 'line', 'line2', 'accent', 'accent_ink', 'ink', 'idle', 'warning', 'attention', 'dot'];
    for (const skin of BUILTIN_SKINS) {
      const color = (role: ColorRole) => readColor((skin.colors as Record<ColorRole, string>)[role])!;
      /* What passes under a block, as it shows over the page's background. */
      const unders = UNDER.map(role => over(color(role), color('bg')));
      const worst = (text: ColorRole) => Math.min(...unders.map(under => contrast(color(text), over(color('hud'), under))));
      for (const text of ['muted', 'ink', 'accent_ink'] as const) expect(worst(text), `${skin.id}: ${text} on a block`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color('accent_ink'), over(color('glow'), color('surface'))), `${skin.id}: the chosen tab`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('what stands under the bars of the shell as one comes or goes', () => {
  it('moves in 200 ms ease-out, and in one step for less motion', () => {
    expect(decl('.shell', '--shell-shift')).toBe('200ms');
    expect(decl('.shell', '--shell-shift', '(prefers-reduced-motion: reduce)')).toBe('0s');
  });

  it("moves the department's name plate by transform only, from 8 px under the menu to 8 px under the last bar", () => {
    /* 8 px on every screen, while the blocks of the menu stand 6 px apart on a phone. */
    expect(decl('.shell', '--under-menu')).toBe('calc(var(--bar-top) + var(--bar-size) + var(--float-gap))');
    expect(rulesFor('.shell').map(r => r.decls['--float-gap']).filter(Boolean)).toEqual(['8px']);
    expect(decl('.crumbs', 'top')).toBe('0');
    expect(decl('.crumbs', 'transform')).toBe('translateY(var(--shell-top, var(--under-menu)))');
    expect(decl('.crumbs', 'transition')).toBe('transform var(--shell-shift) ease-out');
    expect(decl('.crumbs', 'top', '(max-width: 760px)')).toBeUndefined();
    for (const sel of ['.orch', '.acard', '.agent-strips']) expect(decl(sel, 'transition-property') ?? '', `${sel} keeps its top as it opens`).not.toContain('top');
  });

  it("lays an open department's canvas from the top of the window to its bottom, at every width", () => {
    const insets = RULES.filter(r => r.selectors.includes('.dcanvas')).flatMap(r => Object.keys(r.decls).filter(p => p.startsWith('inset')).map(p => `${r.media ?? 'all'}: ${p}: ${r.decls[p]}`));
    expect(insets).toEqual(['all: inset: 0']);
  });
});

/* More is a .btn, whose display beats the hidden attribute: hidden alone left it on every bar at every width. */
describe("a bar's More", () => {
  it('stays hidden where the bar does not fold, and shows only on a phone, on a bar after the first that is not open', () => {
    expect(decl('.bar-more[hidden]', 'display')).toBe('none');
    const shown = RULES.filter(r => r.selectors.some(s => /\.bar-more$/.test(s)) && r.decls.display && r.decls.display !== 'none');
    expect(shown.map(r => r.media)).toEqual(['(max-width: 760px)']);
    expect(shown[0]!.selectors.filter(s => /\.bar-more$/.test(s)).every(s => /~ \.update-banner:not\(\.open\) > \.bar-more$/.test(s))).toBe(true);
  });
});
