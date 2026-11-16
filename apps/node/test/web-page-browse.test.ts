import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { browse, type BrowseDeps, type BrowseRequest, type BrowserContext, type BrowserPage, type BrowserRequest, type Clock, type LaunchOptions } from '../src/web-page/browse.js';
import { afterTwoFrames, collectPage, type PageSample } from '../src/web-page/collect.js';
import type { Folders, ProcessTable } from '../src/web-page/processes.js';

const sample = (name: string): PageSample => JSON.parse(readFileSync(new URL(`./fixtures/web-pages/${name}.json`, import.meta.url), 'utf8')) as PageSample;
const LIMITS = { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 };
const SETTLE = 25_000;
const NAMES: Record<string, string[]> = { 'shop.example': ['93.184.215.14'], 'inside.example': ['10.9.8.7'] };

/* Time moves only when a test moves it. until(n) waits, with no deadline, for the n-th timer to be set. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fire(): void; off: boolean }[] = [];
  const watchers: (() => void)[] = [];
  const clock: Clock & { advance(ms: number): void; until(count: number): Promise<void> } = {
    now: () => now,
    after(ms) {
      let fire!: () => void;
      const done = new Promise<void>(resolve => { fire = resolve; });
      const timer = { at: now + ms, fire, off: false };
      timers.push(timer);
      for (const watch of watchers.splice(0)) watch();
      return { done, cancel: () => { timer.off = true; } };
    },
    advance(ms) {
      now += ms;
      for (const timer of timers) if (!timer.off && timer.at <= now) { timer.off = true; timer.fire(); }
    },
    until: count => new Promise(resolve => {
      const check = () => (timers.length >= count ? resolve() : watchers.push(check));
      check();
    }),
  };
  return clock;
}

type Navigation = 'answer' | 'busy' | 'hang' | 'through-proxy' | 'plain-redirect' | 'fail';
type FakeOptions = {
  navigation?: Navigation; finalUrl?: string; status?: number; sample?: PageSample; collect?: 'hang' | 'fail'; launch?: 'fail' | 'hang'; close?: 'hang';
  target?: string; asks?: string[]; waitFor?: 'missing'; shot?: 'fail';
};

/* Playwright's Chromium as hh-browse drives it: what it was asked, in order, and the answers of a recorded page. */
function fakeBrowser(o: FakeOptions = {}) {
  const calls: string[] = [];
  const launches: { dir: string; options: LaunchOptions }[] = [];
  const listeners = new Map<string, ((r: BrowserRequest) => void)[]>();
  const frame = { name: 'main' };
  const emit = (event: string, r: BrowserRequest) => { for (const fn of listeners.get(event) ?? []) fn(r); };
  const req = (url: string, navigation: boolean): BrowserRequest => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => frame });
  const api = req('https://shop.example/api/items.json', false);
  let navigated!: () => void;
  const reached = new Promise<void>(resolve => { navigated = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let reading!: () => void;
  const collecting = new Promise<void>(resolve => { reading = resolve; });
  let starting!: () => void;
  const launching = new Promise<void>(resolve => { starting = resolve; });
  let options!: LaunchOptions;
  const page: BrowserPage = {
    url: () => o.finalUrl ?? 'https://shop.example/catalogue',
    mainFrame: () => frame,
    goto: async (url, opts) => {
      calls.push(`goto ${url} ${opts.waitUntil}`);
      entered();
      const doc = req(url, true);
      emit('request', doc);
      if (o.navigation === 'hang') return new Promise(() => {});
      if (o.navigation === 'fail') {
        emit('requestfailed', doc);
        throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}\nCall log:\n  - navigating to "${url}"`);
      }
      if (o.navigation === 'plain-redirect') {
        const target = o.target ?? 'http://10.0.0.5/admin';
        emit('request', req(target, true));
        const answer = await fetchThroughProxy(options, target);
        emit('requestfinished', doc);
        return { status: () => answer.status, headers: () => answer.headers };
      }
      if (o.navigation === 'through-proxy') {
        const target = o.target ?? 'http://inside.example/';
        emit('request', req(target, true));
        await askProxy(options, target);
        emit('requestfailed', doc);
        throw new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED');
      }
      for (const asked of o.asks ?? []) await askProxyFor(options, asked);
      emit('requestfinished', doc);
      if (o.navigation === 'busy') emit('request', api);
      navigated();
      return { status: () => o.status ?? 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === afterTwoFrames) { calls.push('frames'); return undefined; }
      if (fn === collectPage) {
        calls.push(`collect ${JSON.stringify(arg)}`);
        reading();
        if (o.collect === 'hang') return new Promise(() => {});
        if (o.collect === 'fail') throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        return o.sample ?? sample('rendered');
      }
      throw new Error('an unknown page function');
    },
    waitForSelector: async selector => {
      calls.push(`wait for ${selector}`);
      if (o.waitFor === 'missing') throw new Error('page.waitForSelector: Timeout 25000ms exceeded.');
      return null;
    },
    screenshot: async shot => {
      calls.push(`screenshot ${shot.fullPage ? 'full' : 'view'}`);
      if (o.shot === 'fail') throw new Error('page.screenshot: Target crashed');
      return Buffer.from('PNG of the page');
    },
  };
  const context: BrowserContext = {
    pages: () => [page],
    newPage: async () => page,
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return context; },
    close: () => { calls.push('close'); return o.close === 'hang' ? new Promise(() => {}) : Promise.resolve(); },
    addCookies: async cookies => { calls.push(`cookies ${cookies.map(c => `${c.name}@${c.domain}`).join(' ')}`); },
    addInitScript: async (_fn, arg) => { calls.push(`stored ${arg.origin} ${arg.items.map(i => i.name).join(' ')}`); },
  };
  return {
    calls, launches, reached, started, collecting, launching,
    finishApi: () => { calls.push('api finished'); emit('requestfinished', api); },
    launcher: {
      launchPersistentContext: async (dir: string, given: LaunchOptions) => {
        launches.push({ dir, options: given });
        options = given;
        starting();
        if (o.launch === 'hang') return new Promise<BrowserContext>(() => {});
        if (o.launch === 'fail') throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /data/browsers/chromium_headless_shell-1248");
        return context;
      },
    },
  };
}

/* Chromium following a redirect: the next hop goes to the proxy as a CONNECT with the run's credentials. */
function askProxy(options: LaunchOptions, target: string) {
  const { hostname } = new URL(target);
  const server = new URL(options.proxy.server);
  const auth = `Basic ${Buffer.from(`${options.proxy.username}:${options.proxy.password}`).toString('base64')}`;
  return new Promise<void>(resolve => {
    const r = request({ host: server.hostname, port: Number(server.port), method: 'CONNECT', path: `${hostname}:443`, headers: { 'proxy-authorization': auth } });
    r.on('connect', (_res, socket) => { socket.destroy(); resolve(); });
    r.on('error', () => resolve());
    r.end();
  });
}

/* A script of the page asking for an address over plain http: the browser sends the whole address to the proxy. */
function askProxyFor(options: LaunchOptions, address: string) {
  const server = new URL(options.proxy.server);
  const auth = `Basic ${Buffer.from(`${options.proxy.username}:${options.proxy.password}`).toString('base64')}`;
  return new Promise<void>(resolve => {
    const r = request({ host: server.hostname, port: Number(server.port), method: 'GET', path: address, headers: { host: new URL(address).host, 'proxy-authorization': auth } }, res => { res.resume(); res.on('end', () => resolve()); });
    r.on('error', () => resolve());
    r.end();
  });
}

/* Chromium following a redirect to a plain http address: the proxy answers for the next hop, and the browser shows that. */
function fetchThroughProxy(options: LaunchOptions, address: string) {
  const server = new URL(options.proxy.server);
  const auth = `Basic ${Buffer.from(`${options.proxy.username}:${options.proxy.password}`).toString('base64')}`;
  return new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
    const r = request({ host: server.hostname, port: Number(server.port), method: 'GET', path: address, headers: { host: new URL(address).host, 'proxy-authorization': auth } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> }));
    });
    r.on('error', reject);
    r.end();
  });
}

function setUp(o: FakeOptions = {}, extra: Partial<BrowseDeps> = {}) {
  const browser = fakeBrowser(o);
  const clock = fakeClock();
  const made: string[] = [];
  const removed: string[] = [];
  const written = new Map<string, Buffer>();
  /* This run is process 700; an earlier run, 555, died and left its folder. */
  const table: ProcessTable = { pids: () => [700], args: () => ['node'], group: () => 700, owner: () => 1000, alive: pid => pid !== 555, kill: () => {} };
  const folders: Folders = { list: () => ['hh-browse-555-old'], owner: () => 1000, remove: path => { removed.push(path); } };
  const deps: BrowseDeps = {
    launcher: () => browser.launcher,
    lookup: async host => NAMES[host] ?? [],
    clock,
    tmp: '/tmp',
    uid: 1000,
    pid: 700,
    table,
    folders,
    makeDir: prefix => { made.push(prefix); return `${prefix}run1`; },
    removeDir: path => { removed.push(path); },
    writeFile: (path, bytes) => { written.set(path, bytes); },
    secret: () => 'run-secret',
    listen: (server: Server) => listenIn(server),
    ...extra,
  };
  return { browser, clock, made, removed, written, deps };
}

const asked = (address: string, more: Partial<BrowseRequest> = {}): BrowseRequest => ({ address, screenshot: null, fullPage: false, waitFor: null, limits: LIMITS, ...more });

describe('hh-browse reading one address in a browser on the node', () => {
  it('refuses an internal address or a name that points inside before any browser starts', async () => {
    for (const address of ['http://127.0.0.1:8080/', 'file:///etc/passwd', 'http://inside.example/']) {
      const { browser, made, deps } = setUp();
      const result = await browse(asked(address), deps);
      expect(result.status, address).toBe('refused');
      expect(result.reason, address).toMatch(/loopback|only http and https|private/);
      expect(browser.launches, address).toEqual([]);
      expect(made, address).toEqual([]);
    }
  });

  it('opens the page through its own proxy, waits for it to load, reads it, takes the screenshot and cleans everything up', async () => {
    const { browser, made, removed, written, deps } = setUp();
    const result = await browse(asked('https://shop.example/catalogue', { screenshot: '/work/catalogue.png' }), deps);
    expect(made).toEqual(['/tmp/hh-browse-700-']);
    const [launch] = browser.launches;
    expect(launch!.dir).toBe('/tmp/hh-browse-700-run1/profile');
    expect(launch!.options).toMatchObject({
      headless: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), bypass: '<-loopback>', username: expect.any(String), password: 'run-secret' },
    });
    expect(launch!.options.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(browser.calls).toEqual(['goto https://shop.example/catalogue load', 'frames', expect.stringMatching(/^collect /), 'screenshot view', 'close']);
    expect(JSON.parse(browser.calls[2]!.slice('collect '.length))).toMatchObject({ maxText: LIMITS.maxText, maxLinks: LIMITS.maxLinks });
    expect(written.get('/work/catalogue.png')?.toString()).toBe('PNG of the page');
    expect(result).toMatchObject({
      status: 'ok', address: 'https://shop.example/catalogue', finalAddress: 'https://shop.example/catalogue', httpStatus: 200,
      title: 'Spring catalogue', textLength: 86, linkCount: 3, screenshot: '/work/catalogue.png', notes: [],
    });
    expect(result.text).toContain('Pruner costs 18 EUR');
    expect(result.links[0]).toEqual({ text: 'Hand trowel', url: 'https://shop.example/items/1' });
    expect(removed).toEqual(['/tmp/hh-browse-555-old', '/tmp/hh-browse-700-run1']);
  });

  it('opens the page with a saved sign-in: its cookies and stored values go in before the page, in the browser it was made in', async () => {
    const { browser, deps } = setUp();
    const signIn = {
      session: {
        cookies: [
          { name: 'sid', value: 'cookie-value-0123456789', domain: '.shop.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
          { name: 'pref', value: 'dark', domain: 'shop.example', path: '/', expires: 4_102_444_800, httpOnly: false, secure: true, sameSite: 'Strict' as const },
        ],
        origins: [{ origin: 'https://shop.example', localStorage: [{ name: 'token', value: 'stored-value-0123456789' }] }],
      },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    };
    const result = await browse(asked('https://shop.example/catalogue', { signIn }), deps);
    expect(result.status).toBe('ok');
    expect(browser.launches[0]!.options.userAgent).toBe('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0');
    expect(browser.calls.slice(0, 3)).toEqual(['cookies sid@.shop.example pref@shop.example', 'stored https://shop.example token', 'goto https://shop.example/catalogue load']);
  });

  it('opens a public page with no sign-in and the browser as it is', async () => {
    const { browser, deps } = setUp();
    await browse(asked('https://shop.example/catalogue'), deps);
    expect(browser.launches[0]!.options.userAgent).toBeUndefined();
    expect(browser.calls.filter(call => /^(cookies|stored) /.test(call))).toEqual([]);
  });

  it('waits for the requests the page still makes after it loaded before it reads it', async () => {
    const { browser, deps } = setUp({ navigation: 'busy' });
    const done = browse(asked('https://shop.example/catalogue'), deps);
    await browser.reached;
    await new Promise(resolve => setImmediate(resolve));
    browser.finishApi();
    const result = await done;
    expect(result.status).toBe('ok');
    expect(browser.calls.slice(0, 3)).toEqual(['goto https://shop.example/catalogue load', 'api finished', 'frames']);
  });

  it('reads what the page shows when it is still loading at the settle limit, and says so', async () => {
    for (const navigation of ['busy', 'hang'] as const) {
      const { browser, clock, deps } = setUp({ navigation });
      const done = browse(asked('https://shop.example/catalogue'), deps);
      await (navigation === 'busy' ? browser.reached : browser.started);
      clock.advance(SETTLE);
      const result = await done;
      expect(result.status, navigation).toBe('ok');
      expect(result.notes, navigation).toEqual([expect.stringMatching(/still loading/)]);
      expect(browser.calls.at(-1), navigation).toBe('close');
    }
  });

  it('gives up at the time limit when the page cannot even be read, and still cleans up', async () => {
    const { browser, clock, removed, deps } = setUp({ collect: 'hang' });
    const done = browse(asked('https://shop.example/catalogue'), deps);
    await browser.collecting;
    clock.advance(LIMITS.timeoutMs);
    const result = await done;
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/time limit of 30 seconds/) });
    expect(browser.calls.at(-1)).toBe('close');
    expect(removed.at(-1)).toBe('/tmp/hh-browse-700-run1');
  });

  it('calls the page refused when the browser was sent on to an internal address, which the proxy never opened', async () => {
    const { browser, deps } = setUp({ navigation: 'through-proxy', target: 'https://inside.example/' });
    const result = await browse(asked('https://shop.example/go'), deps);
    expect(result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/inside\.example[^.]*private/) });
    expect(browser.calls.at(-1)).toBe('close');
  });

  it('reads the page and says which addresses its scripts asked for that the browser never opened', async () => {
    const { deps } = setUp({ asks: ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/admin', 'http://10.0.0.5/'] });
    const result = await browse(asked('https://shop.example/catalogue'), deps);
    expect(result.status).toBe('ok');
    expect(result.notes).toEqual(['The page asked for 3 addresses that are not public, such as 169.254.169.254, localhost and 10.0.0.5; the browser opened none of them.']);
  });

  it('calls the page refused when it sent the browser on to an internal plain http address, which the proxy answered for', async () => {
    const { browser, deps } = setUp({ navigation: 'plain-redirect', target: 'http://10.0.0.5/admin' });
    const result = await browse(asked('https://shop.example/go'), deps);
    expect(result).toMatchObject({ status: 'refused', reason: 'The page sent the browser on to 10.0.0.5, a private network address, which stays closed.' });
    expect(browser.calls.at(-1)).toBe('close');
  });

  it('says why a page that could not be opened failed', async () => {
    const { browser, removed, deps } = setUp({ navigation: 'fail' });
    const result = await browse(asked('https://shop.example/catalogue'), deps);
    expect(result).toMatchObject({ status: 'failed', reason: 'The page could not be opened: net::ERR_NAME_NOT_RESOLVED at https://shop.example/catalogue' });
    expect(browser.calls.at(-1)).toBe('close');
    expect(removed.at(-1)).toBe('/tmp/hh-browse-700-run1');
  });

  it('says why a page that could not be read failed', async () => {
    const { browser, deps } = setUp({ collect: 'fail' });
    const result = await browse(asked('https://shop.example/catalogue'), deps);
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^The page could not be read: Execution context was destroyed/) });
    expect(browser.calls.at(-1)).toBe('close');
  });

  it('still reads the page when the element it waited for never showed and its picture could not be taken, and notes both', async () => {
    const { written, deps } = setUp({ waitFor: 'missing', shot: 'fail' });
    const result = await browse(asked('https://shop.example/catalogue', { waitFor: '#prices', screenshot: '/work/catalogue.png' }), deps);
    expect(result).toMatchObject({ status: 'ok', screenshot: null, notes: ['The page showed no #prices within the time limit.', 'The screenshot could not be taken: Target crashed'] });
    expect(written.size).toBe(0);
  });

  it('fails when the browser does not start within the time limit, and removes what the run made', async () => {
    const { browser, clock, removed, deps } = setUp({ launch: 'hang' });
    const done = browse(asked('https://shop.example/catalogue'), deps);
    await browser.launching;
    clock.advance(SETTLE);
    const result = await done;
    expect(result).toMatchObject({ status: 'failed', reason: 'The browser did not start within the time limit of 30 seconds.' });
    expect(removed).toEqual(['/tmp/hh-browse-555-old', '/tmp/hh-browse-700-run1']);
  });

  it('says why a browser that cannot start failed, and removes what the run made', async () => {
    const { removed, deps } = setUp({ launch: 'fail' });
    const result = await browse(asked('https://shop.example/catalogue'), deps);
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/browser could not start[\s\S]*Executable doesn't exist/) });
    expect(removed).toEqual(['/tmp/hh-browse-555-old', '/tmp/hh-browse-700-run1']);
  });

  it('kills the browser by its profile when it does not close, then removes its folder', async () => {
    const killed: number[] = [];
    const { browser, clock, removed, deps } = setUp({ close: 'hang' });
    deps.table = {
      pids: () => [555, 901],
      args: pid => (pid === 901 ? ['chrome', '--user-data-dir=/tmp/hh-browse-700-run1/profile'] : ['node']),
      group: pid => pid, owner: () => 1000, alive: pid => pid !== 555, kill: pid => { killed.push(pid); },
    };
    const done = browse(asked('https://shop.example/catalogue'), deps);
    await clock.until(3);
    clock.advance(5_000);
    const result = await done;
    expect(result.status).toBe('ok');
    expect(browser.calls.at(-1)).toBe('close');
    expect(killed).toEqual([-901]);
    expect(removed.at(-1)).toBe('/tmp/hh-browse-700-run1');
  });

  it('stops at once when it is told to stop, and cleans up', async () => {
    const controller = new AbortController();
    const { browser, removed, deps } = setUp({ navigation: 'hang' });
    const done = browse(asked('https://shop.example/catalogue', { signal: controller.signal }), deps);
    await browser.started;
    controller.abort();
    const result = await done;
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/stopped/) });
    expect(browser.calls.at(-1)).toBe('close');
    expect(removed.at(-1)).toBe('/tmp/hh-browse-700-run1');
  });

  it('waits for an element it was told of, and takes the whole page when asked', async () => {
    const { browser, deps } = setUp({ sample: sample('sign-in'), finalUrl: 'https://shop.example/portal/login' });
    const result = await browse(asked('https://shop.example/portal', { waitFor: 'form', screenshot: '/work/portal.png', fullPage: true }), deps);
    expect(result.status).toBe('login_required');
    expect(browser.calls).toContain('wait for form');
    expect(browser.calls).toContain('screenshot full');
  });
});
