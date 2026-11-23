import { describe, expect, it } from 'vitest';
import { RULES } from './css';

const PAPYRUS_PREFIX = ":where(:root[data-surface='papyrus'])";
const RAW_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(/i;
const LAYOUT_PROPS = new Set(['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block', 'width', 'height', 'inline-size', 'block-size', 'border-width', 'font-size', 'line-height', 'gap']);

describe('Ancient Egypt papyrus surface styling across all screens', () => {
  const papyrusRules = () => RULES.filter(rule => rule.selectors.some(selector => selector.includes(PAPYRUS_PREFIX)));

  it('covers page ground, panels, dialogs, topbar, tables, controls, tracker, agent window and progress bars', () => {
    const selectors = papyrusRules().flatMap(rule => rule.selectors);
    for (const part of [
      'body',
      '.edge > .edge-in',
      '.dialog',
      '.acard',
      '.dv-drawer',
      '.orch',
      '.tr-side',
      '.tr-card',
      '.tabs.glass',
      '.zoom.glass',
      '.ticker.glass',
      '.btn:not(.ghost)',
      '.ptable th',
      '.bar',
      '.strip',
      '.edge > .corner',
    ]) {
      expect(selectors.some(selector => selector.includes(part)), `missing papyrus styling for ${part}`).toBe(true);
    }
  });

  it('uses only semantic theme tokens with no raw colours and no geometry overrides', () => {
    const rules = papyrusRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const [property, value] of Object.entries(rule.decls)) {
        expect(RAW_COLOR.test(value), `${rule.selectors.join(', ')} -> ${property}: ${value}`).toBe(false);
        expect(LAYOUT_PROPS.has(property), `layout override in ${rule.selectors.join(', ')} -> ${property}`).toBe(false);
      }
    }
  });

  it('uses lapis accent on corner marks, incised double-hairline frames, toggleable map grain and RTL/Arabic joining safety', () => {
    const corner = RULES.find(rule => rule.selectors.includes(":where(:root[data-surface='papyrus']) .edge > .corner"));
    expect(corner?.decls['border-inline-start-color']).toBe('var(--cyan)');
    expect(corner?.decls['border-block-start-color']).toBe('var(--cyan)');

    const incised = RULES.find(rule =>
      rule.selectors.some(s => s.includes(":where(:root[data-surface='papyrus'])") && s.includes('.edge > .edge-in')) &&
      rule.decls['box-shadow']?.includes('inset 0 0 0 3px var(--surface), inset 0 0 0 4px var(--line)'),
    );
    expect(incised, 'missing Design incised double-hairline frame').toBeDefined();

    const rtlTracking = RULES.find(rule => rule.selectors.some(s => s.includes(':lang(ar)')) && rule.decls['letter-spacing'] === '0');
    expect(rtlTracking, 'missing letter-spacing: 0 for Arabic/RTL').toBeDefined();

    const rtlFont = RULES.find(rule =>
      rule.selectors.some(s => s.includes(":root[data-surface='papyrus']") && s.includes(':lang(ar)')) &&
      rule.decls['font-family']?.includes('system-ui'),
    );
    expect(rtlFont, 'missing system-ui override for Arabic/RTL under papyrus').toBeDefined();

    const grainOff = RULES.find(rule => rule.selectors.some(s => s.includes("[data-grain='off']")));
    expect(grainOff, 'missing papyrus grain off selector').toBeDefined();
  });
});
