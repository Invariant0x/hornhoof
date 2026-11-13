import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentTheme, exportTemplate, initTheme, loadTemplate, resetTemplate, setTheme, themeState } from '../src/theme';
import { COLOR_TOKENS, CUT_TOKEN, FONT_TOKENS, parseTemplate, sampleOf, templateText, THEMES } from '../src/theme-template';

const root = document.documentElement;
const TOKENS = [...Object.values(COLOR_TOKENS), ...Object.values(FONT_TOKENS), CUT_TOKEN, 'color-scheme'];
const NEON = { format: 'hornhoof-theme', version: 1, name: 'Neon', base: 'matrix', colors: { bg: '#010203', accent: '#ff00ff' }, cut: 0.5 };
const text = (value: unknown) => JSON.stringify(value);
const inline = () => Object.fromEntries(TOKENS.map(token => [token, root.style.getPropertyValue(token)]).filter(([, v]) => v));

function clearPage() {
  delete root.dataset.theme;
  root.removeAttribute('style');
}

/* A new visit: the page starts clean and reads what the browser kept. */
function nextVisit() {
  clearPage();
  initTheme();
}

beforeEach(() => {
  localStorage.clear();
  nextVisit();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPage();
});

describe('the theme of the page', () => {
  it('follows the system until a person picks a theme', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' }));
    expect(root.dataset.theme).toBeUndefined();
    expect(currentTheme()).toBe('dark');
  });

  it.each(THEMES)('switches to %s at once and keeps it for the next visit', theme => {
    setTheme(theme);
    expect(root.dataset.theme).toBe(theme);
    expect(currentTheme()).toBe(theme);
    expect(localStorage.getItem('hh-theme')).toBe(theme);
    expect(inline()).toEqual({});
    nextVisit();
    expect(root.dataset.theme).toBe(theme);
  });

  it('keeps the choice of a theme from before themes had names', () => {
    localStorage.setItem('hh-theme', 'dark');
    nextVisit();
    expect(root.dataset.theme).toBe('dark');
  });

  it('loads a template, puts its values on the page and keeps it for the next visit', () => {
    expect(loadTemplate(text(NEON))).toBeNull();
    const expected = { [COLOR_TOKENS.bg]: '#010203', [COLOR_TOKENS.accent]: '#ff00ff', [CUT_TOKEN]: '0.5' };
    expect(root.dataset.theme).toBe('matrix');
    expect(inline()).toEqual(expected);
    expect(currentTheme()).toBe('custom');
    expect(themeState().custom?.name).toBe('Neon');
    nextVisit();
    expect(root.dataset.theme).toBe('matrix');
    expect(inline()).toEqual(expected);
    expect(currentTheme()).toBe('custom');
  });

  it('refuses a bad template and leaves the theme and what was kept as they were', () => {
    setTheme('cyberpunk');
    expect(loadTemplate(text({ ...NEON, colors: { bg: 'url(https://example.com/x.png)' } }))).toEqual({ code: 'unsafe', key: 'colors.bg' });
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(inline()).toEqual({});
    expect(localStorage.getItem('hh-theme')).toBe('cyberpunk');
    expect(localStorage.getItem('hh-theme-custom')).toBeNull();
  });

  it('keeps a template aside while a built-in theme is on, and brings it back as the custom choice', () => {
    loadTemplate(text(NEON));
    setTheme('light');
    expect(root.dataset.theme).toBe('light');
    expect(inline()).toEqual({});
    expect(themeState().custom?.name).toBe('Neon');
    setTheme('custom');
    expect(root.dataset.theme).toBe('matrix');
    expect(inline()[COLOR_TOKENS.bg]).toBe('#010203');
  });

  it('resets the template to the built-in theme it was made from', () => {
    loadTemplate(text(NEON));
    resetTemplate();
    expect(root.dataset.theme).toBe('matrix');
    expect(inline()).toEqual({});
    expect(themeState()).toEqual({ choice: 'matrix', custom: null });
    expect(localStorage.getItem('hh-theme')).toBe('matrix');
    expect(localStorage.getItem('hh-theme-custom')).toBeNull();
    setTheme('custom');
    expect(root.dataset.theme).toBe('matrix');
    expect(currentTheme()).toBe('matrix');
  });

  it('keeps the chosen built-in theme when a template that is not on is reset', () => {
    loadTemplate(text(NEON));
    setTheme('dark');
    resetTemplate();
    expect(themeState()).toEqual({ choice: 'dark', custom: null });
    expect(root.dataset.theme).toBe('dark');
  });

  it.each(THEMES)('gives out %s as a sample to start a template from', theme => {
    setTheme(theme);
    expect(exportTemplate()).toBe(templateText(sampleOf(theme)));
  });

  it('gives out the template that is on with every value it does not change taken from its base', () => {
    loadTemplate(text(NEON));
    const result = parseTemplate(exportTemplate());
    expect(result.ok && result.template).toEqual({ ...sampleOf('matrix'), name: 'Neon', colors: { ...sampleOf('matrix').colors, bg: '#010203', accent: '#ff00ff' }, cut: 0.5 });
  });

  it('gives out the theme the system shows when nothing is chosen', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' }));
    expect(exportTemplate()).toBe(templateText(sampleOf('dark')));
  });
});

describe('when the browser keeps nothing or something broken', () => {
  it('opens on a built-in theme and still switches when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => nextVisit()).not.toThrow();
    expect(root.dataset.theme).toBeUndefined();
    setTheme('matrix');
    expect(root.dataset.theme).toBe('matrix');
    expect(loadTemplate(text(NEON))).toBeNull();
    expect(inline()[COLOR_TOKENS.bg]).toBe('#010203');
    expect(() => resetTemplate()).not.toThrow();
    expect(root.dataset.theme).toBe('matrix');
  });

  it('opens on a built-in theme when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => nextVisit()).not.toThrow();
    expect(root.dataset.theme).toBeUndefined();
    setTheme('cyberpunk');
    expect(root.dataset.theme).toBe('cyberpunk');
  });

  it.each([
    ['an unknown theme', { 'hh-theme': 'neon' }],
    ['a custom choice without a template', { 'hh-theme': 'custom' }],
    ['a template that is not JSON', { 'hh-theme': 'custom', 'hh-theme-custom': '{"format": "hornhoof-theme"' }],
    ['a template with code in it', { 'hh-theme': 'custom', 'hh-theme-custom': text({ ...NEON, colors: { bg: '#fff; background: url(x)' } }) }],
    ['a template of another format', { 'hh-theme': 'custom', 'hh-theme-custom': text({ ...NEON, version: 9 }) }],
  ])('opens on a built-in theme when it keeps %s', (_what, kept) => {
    for (const [key, value] of Object.entries(kept)) localStorage.setItem(key, value);
    nextVisit();
    expect(root.dataset.theme).toBeUndefined();
    expect(inline()).toEqual({});
    expect(themeState()).toEqual({ choice: null, custom: null });
  });

  it('keeps a chosen built-in theme when only the template it kept is broken', () => {
    localStorage.setItem('hh-theme', 'cyberpunk');
    localStorage.setItem('hh-theme-custom', '<script>');
    nextVisit();
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(themeState()).toEqual({ choice: 'cyberpunk', custom: null });
  });
});
