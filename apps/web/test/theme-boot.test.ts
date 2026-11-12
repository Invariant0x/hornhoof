import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { bundleThemeBoot, themeBoot } from '../theme-boot.config';
import { COLOR_TOKENS } from '../src/theme-template';

const root = document.documentElement;
/* A hook of the plugin as the function it is, whichever form Vite allows it to take. */
type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: Plugin, name: keyof Plugin): Hook => {
  const found = plugin[name] as Hook | { handler: Hook };
  return typeof found === 'function' ? found : found.handler;
};
const plugins = () => {
  const [dev, built] = themeBoot();
  return { dev: dev!, built: built! };
};

afterEach(() => {
  delete root.dataset.theme;
  root.removeAttribute('style');
});

describe('the theme before the page draws', () => {
  it('puts a plain script at the very top of the head while developing, and serves it fresh each time', async () => {
    const { dev } = plugins();
    expect(dev.apply).toBe('serve');
    expect(hook(dev, 'transformIndexHtml').call({}, '<html></html>', {})).toEqual([{ tag: 'script', attrs: { src: '/theme-boot.js' }, injectTo: 'head-prepend' }]);
    const served: { path?: string; serve?: (req: unknown, res: unknown, next: (error: unknown) => void) => void } = {};
    hook(dev, 'configureServer').call({}, { middlewares: { use: (path: string, serve: typeof served.serve) => Object.assign(served, { path, serve }) } });
    const headers: Record<string, string> = {};
    const body = await new Promise<string>((resolve, reject) => {
      served.serve!({}, { setHeader: (name: string, value: string) => (headers[name] = value), end: resolve }, reject);
    });
    expect(served.path).toBe('/theme-boot.js');
    expect(headers).toEqual({ 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    expect(body).toBe(await bundleThemeBoot());
  });

  it('writes the script to assets under a name that changes with what it holds, and points the page at it', async () => {
    const { built } = plugins();
    expect(built.apply).toBe('build');
    hook(built, 'configResolved').call({}, { base: '/' });
    await hook(built, 'buildStart').call({});
    const emitted: { fileName: string; source: string }[] = [];
    hook(built, 'generateBundle').call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) });
    const code = await bundleThemeBoot();
    expect(emitted).toEqual([{ type: 'asset', fileName: expect.stringMatching(/^assets\/theme-boot-[0-9a-f]{8}\.js$/), source: code }]);
    expect(hook(built, 'transformIndexHtml').call({}, '<html></html>', {})).toEqual([{ tag: 'script', attrs: { src: `/${emitted[0]!.fileName}` }, injectTo: 'head-prepend' }]);
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
