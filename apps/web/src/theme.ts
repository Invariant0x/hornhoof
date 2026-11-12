import { declarations, filledIn, isBuiltinTheme, parseTemplate, sampleOf, TEMPLATE_PROPERTIES, templateText, type BuiltinTheme, type Template, type TemplateError } from './theme-template';

/* The theme a person picked: one of the built-in ones, or the custom template they loaded. */
export type Theme = BuiltinTheme | 'custom';
/* choice is null until a person picks one: the system's light or dark then applies. */
export type ThemeState = { choice: Theme | null; custom: Template | null };

const KEY = 'hh-theme';
const CUSTOM_KEY = 'hh-theme-custom';
const root = () => document.documentElement;

let state: ThemeState = { choice: null, custom: null };
const listeners = new Set<() => void>();

/* Storage can be missing, blocked or full: the theme then still applies for this visit. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Not kept, but applied for this visit. */
  }
}

/* What the browser kept, checked again as strictly as a file: a value it cannot read is no choice at all. */
function readState(): ThemeState {
  const saved = stored(KEY);
  const text = stored(CUSTOM_KEY);
  const parsed = text === null ? null : parseTemplate(text);
  const custom = parsed?.ok ? parsed.template : null;
  if (saved === 'custom') return custom ? { choice: 'custom', custom } : { choice: null, custom: null };
  return { choice: isBuiltinTheme(saved) ? saved : null, custom };
}

function apply(next: ThemeState): void {
  const page = root();
  const custom = next.choice === 'custom' ? next.custom : null;
  const base = custom ? custom.base : next.choice;
  if (base === null || base === 'custom') delete page.dataset.theme;
  else page.dataset.theme = base;
  for (const property of TEMPLATE_PROPERTIES) page.style.removeProperty(property);
  if (custom) for (const [property, value] of declarations(custom)) page.style.setProperty(property, value);
}

function change(next: ThemeState): void {
  state = next;
  apply(next);
  listeners.forEach(listener => listener());
}

/* Runs before the page draws, from the script at the top of index.html, and again when the app starts. */
export function initTheme(): void {
  change(readState());
}

export const themeState = (): ThemeState => state;

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const systemTheme = (): BuiltinTheme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/* The theme on the page now: the chosen one, or the system's while none is chosen. */
export function currentTheme(): Theme {
  return state.choice ?? systemTheme();
}

/* Custom applies only while a template is kept. */
export function setTheme(theme: Theme): void {
  if (theme === 'custom' && !state.custom) return;
  keep(KEY, theme);
  change({ ...state, choice: theme });
}

/* Reads a template file; a good one is kept and turned on at once, a bad one changes nothing and says why. */
export function loadTemplate(text: string): TemplateError | null {
  const parsed = parseTemplate(text);
  if (!parsed.ok) return parsed.error;
  keep(CUSTOM_KEY, templateText(parsed.template));
  keep(KEY, 'custom');
  change({ choice: 'custom', custom: parsed.template });
  return null;
}

/* Forgets the template; while it was on, the built-in theme it was made from takes its place. */
export function resetTemplate(): void {
  const choice = state.choice === 'custom' ? (state.custom?.base ?? null) : state.choice;
  keep(CUSTOM_KEY, null);
  if (choice) keep(KEY, choice);
  change({ choice, custom: null });
}

/* The theme on the page as a whole template, a sample to start a custom one from. */
export function exportTemplate(): string {
  const theme = currentTheme();
  return templateText(theme === 'custom' && state.custom ? filledIn(state.custom) : sampleOf(theme === 'custom' ? systemTheme() : theme));
}
