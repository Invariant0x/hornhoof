import { join } from 'node:path';
import { checkAddress, vetHost, type Lookup } from './address.js';
import { afterTwoFrames, collectPage, ROBOT_MARKERS, type PageSample } from './collect.js';
import { FOLDER_PREFIX, profileOf, reapProfile, sweepStale, type Folders, type ProcessTable } from './processes.js';
import { REFUSED_HEADER, SIZE_LIMIT, startProxy, type Dial, type Proxy, type Refused } from './proxy.js';
import { judgePage, type Answer, type BrowseResult } from './read.js';
import type { Server } from 'node:http';

/* One address in Chromium on the node: through the proxy of this call, on a profile of its own, within its limits of time
   and size, and with every process of the browser ended and its folder removed however the call ends. The page counts as
   loaded by its own events: its load, then no request left in flight, then two frames drawn. No wait is a number of seconds;
   the limits only bound how long the call may take. */

export type Clock = { now(): number; after(ms: number): { done: Promise<void>; cancel(): void } };
export const realClock: Clock = {
  now: () => Date.now(),
  after: ms => {
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
    return { done, cancel: () => clearTimeout(timer) };
  },
};

export type Limits = { timeoutMs: number; maxText: number; maxLinks: number; maxBytes: number };
export type BrowseRequest = { address: string; screenshot: string | null; fullPage: boolean; waitFor: string | null; limits: Limits; signal?: AbortSignal };

/* What hh-browse uses of Playwright's Chromium. */
export type BrowserRequest = { url(): string; isNavigationRequest(): boolean; frame(): unknown };
export type BrowserResponse = { status(): number; headers(): Record<string, string> };
export type Shot = { type: 'png'; fullPage: boolean; clip?: { x: number; y: number; width: number; height: number }; timeout: number };
export type BrowserPage = {
  url(): string;
  mainFrame(): unknown;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<BrowserResponse | null>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  waitForSelector(selector: string, options: { state: 'visible'; timeout: number }): Promise<unknown>;
  screenshot(options: Shot): Promise<Buffer>;
};
export type BrowserContext = {
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
  on(event: 'request' | 'requestfinished' | 'requestfailed', listener: (request: BrowserRequest) => void): unknown;
  close(): Promise<void>;
};
export type LaunchOptions = {
  headless: true;
  proxy: { server: string; bypass: string; username: string; password: string };
  args: string[];
  viewport: { width: number; height: number };
  acceptDownloads: false;
  serviceWorkers: 'block';
  handleSIGINT: false;
  handleSIGTERM: false;
  handleSIGHUP: false;
  timeout: number;
};
export type Launcher = { launchPersistentContext(dir: string, options: LaunchOptions): Promise<BrowserContext> };

export type BrowseDeps = {
  launcher(): Launcher;
  lookup: Lookup;
  clock: Clock;
  tmp: string;
  uid: number;
  pid: number;
  table: ProcessTable;
  folders: Folders;
  makeDir(prefix: string): string;
  removeDir(path: string): void;
  writeFile(path: string, bytes: Buffer): void;
  secret(): string;
  dial?: Dial;
  listen?: (server: Server) => Promise<number>;
};

const VIEWPORT = { width: 1280, height: 800 };
const MAX_SHOT_HEIGHT = 10_000;
const CLOSE_MS = 5000;
const MAX_RESERVE_MS = 5000;
/* WebRTC would otherwise send UDP past the proxy, to any address a page names. */
const BROWSER_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

type Outcome<T> = { kind: 'done'; value: T } | { kind: 'error'; error: unknown } | { kind: 'late' } | { kind: 'stopped' };

/* What finishes first: the step, its limit or a stop. */
function race<T>(work: Promise<T>, limit: Promise<void>, stop: Promise<void>): Promise<Outcome<T>> {
  return Promise.race([
    work.then((value): Outcome<T> => ({ kind: 'done', value }), (error: unknown): Outcome<T> => ({ kind: 'error', error })),
    limit.then((): Outcome<T> => ({ kind: 'late' })),
    stop.then((): Outcome<T> => ({ kind: 'stopped' })),
  ]);
}

const stopOf = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const said = (error: unknown): string => {
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/^[\w.]+: /, '').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
};

const hostOf = (address: string): string => {
  try {
    return new URL(address).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
};

function emptyResult(address: string): BrowseResult {
  return { status: 'failed', reason: null, address, finalAddress: null, httpStatus: null, title: null, text: null, textLength: 0, links: [], linkCount: 0, screenshot: null, notes: [] };
}

/* Watches the requests of the page: which are still in flight, and where the main frame was sent. */
function watchRequests(context: BrowserContext, page: BrowserPage) {
  const inflight = new Set<BrowserRequest>();
  const sentTo = new Set<string>();
  let waiting: (() => void)[] = [];
  context.on('request', request => {
    inflight.add(request);
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) sentTo.add(hostOf(request.url()));
  });
  const ended = (request: BrowserRequest) => {
    inflight.delete(request);
    if (inflight.size) return;
    const wake = waiting;
    waiting = [];
    for (const resolve of wake) resolve();
  };
  context.on('requestfinished', ended);
  context.on('requestfailed', ended);
  return {
    sentTo,
    quiet: (): Promise<void> => (inflight.size ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve()),
  };
}

function shotOptions(fullPage: boolean, height: number, timeout: number): Shot {
  if (!fullPage) return { type: 'png', fullPage: false, timeout };
  if (height <= MAX_SHOT_HEIGHT) return { type: 'png', fullPage: true, timeout };
  return { type: 'png', fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_SHOT_HEIGHT }, timeout };
}

export async function browse(request: BrowseRequest, deps: BrowseDeps): Promise<BrowseResult> {
  const result = emptyResult(request.address);
  const checked = checkAddress(request.address);
  if (!checked.ok) return { ...result, status: 'refused', reason: `The address is refused: ${checked.reason}.` };
  const vetted = await vetHost(checked.url.hostname, deps.lookup);
  if (!vetted.ok) return { ...result, status: 'refused', reason: `The address is refused: ${vetted.reason}.` };

  sweepStale(deps.tmp, deps.folders, deps.table, deps.uid);
  const { timeoutMs, maxText, maxLinks, maxBytes } = request.limits;
  const seconds = Math.round(timeoutMs / 1000);
  const settleMs = timeoutMs - Math.min(MAX_RESERVE_MS, Math.floor(timeoutMs / 5));
  const start = deps.clock.now();
  const left = (until: number) => Math.max(1, until - (deps.clock.now() - start));
  const settle = deps.clock.after(settleMs);
  const hard = deps.clock.after(timeoutMs);
  const stop = stopOf(request.signal);
  const dir = deps.makeDir(join(deps.tmp, `${FOLDER_PREFIX}${deps.pid}-`));
  const profile = profileOf(dir);
  let proxy: Proxy | null = null;
  let context: BrowserContext | null = null;
  const failed = (reason: string): BrowseResult => ({ ...result, status: 'failed', reason });
  const stopped = () => failed('The call was stopped before the page was read.');
  const lateRead = () => failed(`The page could not be read within the time limit of ${seconds} seconds.`);

  /* Only this call's browser knows the proxy's password: no other process on the machine uses the proxy. */
  const credentials = { username: 'hh-browse', password: deps.secret() };

  try {
    const shut = await startProxy({ lookup: deps.lookup, maxBytes, credentials, dial: deps.dial, listen: deps.listen });
    proxy = shut;
    /* A browser that cannot even be loaded fails the call like one that cannot start. */
    const launching = Promise.resolve().then(() => deps.launcher().launchPersistentContext(profile, {
      headless: true,
      /* <-loopback> sends the loopback addresses through the proxy too, which refuses them. */
      proxy: { server: `http://127.0.0.1:${shut.port}`, bypass: '<-loopback>', ...credentials },
      args: BROWSER_ARGS,
      viewport: VIEWPORT,
      acceptDownloads: false,
      serviceWorkers: 'block',
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: left(settleMs),
    }));
    const launched = await race(launching, settle.done, stop);
    if (launched.kind !== 'done') void launching.then(late => late.close(), () => {});
    if (launched.kind === 'stopped') return stopped();
    if (launched.kind === 'late') return failed(`The browser did not start within the time limit of ${seconds} seconds.`);
    if (launched.kind === 'error') return failed(`The browser could not start: ${said(launched.error)}`);
    context = launched.value;

    const opened = await race(context.pages()[0] ? Promise.resolve(context.pages()[0]!) : context.newPage(), settle.done, stop);
    if (opened.kind === 'stopped') return stopped();
    if (opened.kind === 'late') return lateRead();
    if (opened.kind === 'error') return failed(`The browser could not open a page: ${said(opened.error)}`);
    const page = opened.value;
    const requests = watchRequests(context, page);
    const refusal = () => shut.refused.find(r => requests.sentTo.has(r.host));

    const went = await race(page.goto(request.address, { waitUntil: 'load', timeout: left(settleMs) }), settle.done, stop);
    if (went.kind === 'stopped') return stopped();
    if (went.kind === 'error') {
      const refused = refusal();
      if (refused) return { ...result, status: 'refused', reason: `The page sent the browser on to ${refused.host}, ${refused.reason}, which stays closed.` };
      if (shut.overLimit()) return failed(`The page is larger than the size limit of ${Math.round(maxBytes / 1048576)} MB.`);
      return failed(`The page could not be opened: ${said(went.error)}`);
    }
    const response = went.kind === 'done' ? went.value : null;
    const answer: Answer = response ? { status: response.status(), headers: response.headers() } : null;
    if (answer && answer.headers[REFUSED_HEADER]) {
      const refused = refusal();
      return { ...result, status: 'refused', reason: `The page sent the browser on to ${refused?.host ?? 'an address'}, ${answer.headers[REFUSED_HEADER]}, which stays closed.` };
    }
    let stillLoading = went.kind === 'late';
    if (!stillLoading) {
      const settled = await race(requests.quiet(), settle.done, stop);
      if (settled.kind === 'stopped') return stopped();
      stillLoading = settled.kind === 'late';
    }

    const drawn = await race(page.evaluate(afterTwoFrames), hard.done, stop);
    if (drawn.kind === 'stopped') return stopped();
    if (drawn.kind === 'late') return lateRead();
    const notes: string[] = [];
    if (request.waitFor) {
      const seen = await race(page.waitForSelector(request.waitFor, { state: 'visible', timeout: left(settleMs) }), settle.done, stop);
      if (seen.kind === 'stopped') return stopped();
      if (seen.kind !== 'done') notes.push(`The page showed no ${request.waitFor} within the time limit.`);
    }

    const got = await race(page.evaluate(collectPage, { maxText, maxLinks, markers: ROBOT_MARKERS }), hard.done, stop);
    if (got.kind === 'stopped') return stopped();
    if (got.kind === 'late') return lateRead();
    if (got.kind === 'error') return failed(`The page could not be read: ${said(got.error)}`);
    const sample = got.value as PageSample;

    let screenshot: string | null = null;
    if (request.screenshot) {
      const shot = await race(page.screenshot(shotOptions(request.fullPage, sample.height, left(timeoutMs))), hard.done, stop);
      if (shot.kind === 'stopped') return stopped();
      if (shot.kind === 'done') {
        deps.writeFile(request.screenshot, shot.value);
        screenshot = request.screenshot;
      } else notes.push(shot.kind === 'late' ? 'The screenshot was not taken within the time limit.' : `The screenshot could not be taken: ${said(shot.error)}`);
    }

    const finalAddress = page.url();
    const judged = judgePage({ requested: request.address, finalUrl: finalAddress, answer, sample });
    if (stillLoading) notes.unshift('The page was still loading at the time limit; what it showed by then is below.');
    if (shut.overLimit()) notes.push(`The page reached the size limit of ${Math.round(maxBytes / 1048576)} MB; the rest of it did not load.`);
    const kept = shut.refused.filter(r => r.reason !== SIZE_LIMIT && !requests.sentTo.has(r.host));
    if (kept.length) notes.push(keptOut(kept));
    return {
      status: judged.status, reason: judged.reason, address: request.address, finalAddress, httpStatus: answer?.status ?? null,
      title: sample.title, text: sample.text, textLength: sample.textLength, links: sample.links, linkCount: sample.linkCount,
      screenshot, notes: [...notes, ...judged.notes],
    };
  } finally {
    settle.cancel();
    hard.cancel();
    await cleanUp(context, profile, dir, proxy, deps);
  }
}

/* What the page's own requests asked for that the proxy never opened. */
function keptOut(refused: Refused[]): string {
  const hosts = [...new Set(refused.map(r => r.host))];
  const named = hosts.slice(0, 3);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  if (refused.length === 1) return `The page asked for ${list}, an address that is not public; the browser did not open it.`;
  return `The page asked for ${refused.length} addresses that are not public, such as ${list}; the browser opened none of them.`;
}

/* The browser closes, or is killed by its profile when it does not close within its allowance; then the proxy stops and
   the call's folder goes. */
async function cleanUp(context: BrowserContext | null, profile: string, dir: string, proxy: Proxy | null, deps: BrowseDeps): Promise<void> {
  if (context) {
    const allowance = deps.clock.after(CLOSE_MS);
    await Promise.race([context.close().catch(() => {}), allowance.done]);
    allowance.cancel();
  }
  reapProfile(profile, deps.table, deps.uid);
  await proxy?.close();
  try {
    deps.removeDir(dir);
  } catch {
    /* The next call removes it. */
  }
}
