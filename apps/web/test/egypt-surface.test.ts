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
});
