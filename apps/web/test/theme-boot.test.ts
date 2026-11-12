import { afterEach, describe, expect, it } from 'vitest';
import type { IndexHtmlTransformHook, Plugin } from 'vite';
import { bundleThemeBoot, themeBoot } from '../theme-boot-plugin';
import { COLOR_TOKENS } from '../src/theme-template';

const root = document.documentElement;

function headTags(plugin: Plugin, command: 'serve' | 'build') {
  const hook = plugin.transformIndexHtml as { handler: IndexHtmlTransformHook } | IndexHtmlTransformHook;
  const handler = typeof hook === 'function' ? hook : hook.handler;
  (plugin.configResolved as (config: unknown) => void)?.({ command, base: '/' });
  return handler.call({} as never, '<html><head></head><body></body></html>', { path: '/index.html', filename: 'index.html' });
}

afterEach(() => {
  delete root.dataset.theme;
  root.removeAttribute('style');
});

describe('the theme before the page draws', () => {
  it('puts a plain script at the very top of the head, which the browser runs before it draws anything', () => {
    expect(headTags(themeBoot(), 'serve')).toEqual([{ tag: 'script', attrs: { src: '/theme-boot.js' }, injectTo: 'head-prepend' }]);
  });

  it('builds that script as one file with no imports, which sets the saved theme and template', async () => {
    const code = await bundleThemeBoot();
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    localStorage.setItem('hh-theme', 'custom');
    localStorage.setItem('hh-theme-custom', JSON.stringify({ format: 'hornhoof-theme', version: 1, base: 'matrix', colors: { bg: '#010203' } }));
    new Function(code)();
    expect(root.dataset.theme).toBe('matrix');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#010203');
  });
});
