import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { bundleSkinsBoot, skinsBoot } from '../skins-boot.config';
import { builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS } from '../src/skins/roles';
import { builtinFile, skinText } from '../src/skins/validate';

const root = document.documentElement;
const SKINS = resolve(process.cwd(), 'src/skins');
/* A hook of the plugin as the function it is, whichever form Vite allows it to take. */
type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: Plugin, name: keyof Plugin): Hook => {
  const found = plugin[name] as Hook | { handler: Hook };
  return typeof found === 'function' ? found : found.handler;
};
type Serve = (req: unknown, res: unknown, next: (error: unknown) => void) => void;

/* The dev plugin on a stand-in server: what it serves, and the changes of files its watcher hears. */
function devServer(plugin: Plugin) {
  const served: { path?: string; serve?: Serve } = {};
  const heard: ((event: string, file: string) => void)[] = [];
  hook(plugin, 'configureServer').call({}, {
    middlewares: { use: (path: string, serve: Serve) => Object.assign(served, { path, serve }) },
    watcher: { on: (event: string, listener: (event: string, file: string) => void) => event === 'all' && heard.push(listener) },
  });
  const request = () => new Promise<{ body: string; headers: Record<string, string> }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    served.serve!({}, { setHeader: (name: string, value: string) => (headers[name] = value), end: (body: string) => resolve({ body, headers }) }, reject);
  });
  const change = (file: string) => heard.forEach(listener => listener('change', file));
  return { path: served.path, request, change };
}

afterEach(() => {
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.cut;
  delete root.dataset.world;
  delete root.dataset.surface;
  root.removeAttribute('style');
  localStorage.clear();
});

describe('the skin before the page draws', () => {
  it('puts a plain script at the very top of the head while developing', async () => {
    const [dev] = skinsBoot(async () => 'code');
    expect(dev!.apply).toBe('serve');
    expect(hook(dev!, 'transformIndexHtml').call({}, '<html></html>', {})).toEqual([{ tag: 'script', attrs: { src: '/skins-boot.js' }, injectTo: 'head-prepend' }]);
    const server = devServer(dev!);
    expect(server.path).toBe('/skins-boot.js');
    expect(await server.request()).toEqual({ body: 'code', headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } });
  });

  it('builds that script once for every page while developing, and again only after a file of the skins changes', async () => {
    let builds = 0;
    const [dev] = skinsBoot(async () => `code ${++builds}`);
    const server = devServer(dev!);
    expect((await server.request()).body).toBe('code 1');
    expect((await server.request()).body).toBe('code 1');
    expect(builds).toBe(1);
    server.change(join(SKINS, '..', 'App.tsx'));
    expect((await server.request()).body).toBe('code 1');
    server.change(join(SKINS, 'registry.ts'));
    expect((await server.request()).body).toBe('code 2');
    expect((await server.request()).body).toBe('code 2');
    expect(builds).toBe(2);
  });

  it('tries the build again on the next page after one failed', async () => {
    let builds = 0;
    const [dev] = skinsBoot(async () => {
      builds += 1;
      if (builds === 1) throw new Error('broken while editing');
      return 'fixed';
    });
    const server = devServer(dev!);
    await expect(server.request()).rejects.toThrow('broken while editing');
    expect((await server.request()).body).toBe('fixed');
  });

  it('writes the script to assets under a name that changes with what it holds, and points the page at it', async () => {
    const [, built] = skinsBoot(async () => 'built code');
    expect(built!.apply).toBe('build');
    hook(built!, 'configResolved').call({}, { base: '/' });
    await hook(built!, 'buildStart').call({});
    const emitted: { fileName: string; source: string }[] = [];
    hook(built!, 'generateBundle').call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) });
    expect(emitted).toEqual([{ type: 'asset', fileName: expect.stringMatching(/^assets\/skins-boot-[0-9a-f]{8}\.js$/), source: 'built code' }]);
    expect(hook(built!, 'transformIndexHtml').call({}, '<html></html>', {})).toEqual([{ tag: 'script', attrs: { src: `/${emitted[0]!.fileName}` }, injectTo: 'head-prepend' }]);
  });

  it('builds the script as one file with no imports, which puts the chosen skin of the collection on the page', async () => {
    const code = await bundleSkinsBoot();
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    const sample = builtinFile(builtinSkin('pixel')!, { ru: 'Глубина', en: 'Deep' });
    const own = { ...sample, colors: { ...sample.colors, bg: '#010203' } };
    localStorage.setItem('hh-skins', JSON.stringify([{ id: 'custom-1', skin: JSON.parse(skinText(own)) }]));
    localStorage.setItem('hh-theme', 'custom-1');
    new Function(code)();
    expect([root.dataset.theme, root.dataset.cut]).toEqual(['custom-1', 'steps']);
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#010203');
  });

  it('applies Ancient Egypt world and surface attributes before the app runs', async () => {
    const code = await bundleSkinsBoot();
    localStorage.setItem('hh-theme', 'egypt');
    new Function(code)();
    expect([root.dataset.theme, root.dataset.scheme, root.dataset.world, root.dataset.surface]).toEqual(['egypt', 'light', 'egypt', 'papyrus']);
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe(builtinSkin('egypt')!.colors.bg);
  });
});
