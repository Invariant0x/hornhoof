import type { Plugin } from 'vite';

/* Stub: the theme is not set before the page draws yet. */
export const themeBoot = (): Plugin => ({ name: 'hornhoof-theme-boot', transformIndexHtml: () => [] });
export const bundleThemeBoot = async (): Promise<string> => '';
