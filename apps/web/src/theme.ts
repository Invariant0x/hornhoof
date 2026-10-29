export type Theme = 'light' | 'dark';

const KEY = 'hh-theme';
const root = () => document.documentElement;

export function initTheme(): void {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root().dataset.theme = saved;
  } catch {
    /* Storage can be blocked; the system theme still applies. */
  }
}

export function currentTheme(): Theme {
  const set = root().dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  root().dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Not saved, but applied for this visit. */
  }
}
