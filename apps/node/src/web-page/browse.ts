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
type BrowserResponse = { status(): number; headers(): Record<string, string> };
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

/* One call while it runs: what it was asked, its limits and alarms, and what it started, which it ends. */
type Call = {
  request: BrowseRequest;
  deps: BrowseDeps;
  base: BrowseResult;
  seconds: number;
  settleMs: number;
  settle: { done: Promise<void>; cancel(): void };
  hard: { done: Promise<void>; cancel(): void };
  stop: Promise<void>;
  dir: string;
  profile: string;
  credentials: { username: string; password: string };
  left(until: number): number;
  proxy: Proxy | null;
  context: BrowserContext | null;
};

/* A step that ends the call before the page is read, with the result it ends with. */
class Ended {
  constructor(readonly result: BrowseResult) {}
}

const failed = (call: Call, reason: string): Ended => new Ended({ ...call.base, status: 'failed', reason });
const refusedBy = (call: Call, reason: string): Ended => new Ended({ ...call.base, status: 'refused', reason });
const stopped = (call: Call): Ended => failed(call, 'The call was stopped before the page was read.');
const lateRead = (call: Call): Ended => failed(call, `The page could not be read within the time limit of ${call.seconds} seconds.`);
const sizeLimit = (call: Call): string => `${Math.round(call.request.limits.maxBytes / 1048576)} MB`;

/* What finished first of the step and its limit; a stop ends the call. */
async function step<T>(call: Call, work: Promise<T>, limit: Promise<void>): Promise<Exclude<Outcome<T>, { kind: 'stopped' }>> {
  const outcome = await race(work, limit, call.stop);
  if (outcome.kind === 'stopped') throw stopped(call);
  return outcome;
}

/* The step's value; a step that is late or fails ends the call with the reason given. */
async function must<T>(call: Call, work: Promise<T>, limit: Promise<void>, late: () => Ended, cannot: string): Promise<T> {
  const outcome = await step(call, work, limit);
  if (outcome.kind === 'done') return outcome.value;
  throw outcome.kind === 'late' ? late() : failed(call, `${cannot}: ${said(outcome.error)}`);
}

/* Why the address may not be opened at all, or null. */
async function refusal(address: string, lookup: Lookup): Promise<string | null> {
  const checked = checkAddress(address);
  if (!checked.ok) return checked.reason;
  const vetted = await vetHost(checked.url.hostname, lookup);
  return vetted.ok ? null : vetted.reason;
}

function begin(request: BrowseRequest, deps: BrowseDeps): Call {
  const { timeoutMs } = request.limits;
  const settleMs = timeoutMs - Math.min(MAX_RESERVE_MS, Math.floor(timeoutMs / 5));
  const start = deps.clock.now();
  const settle = deps.clock.after(settleMs);
  const hard = deps.clock.after(timeoutMs);
  const stop = stopOf(request.signal);
  const dir = deps.makeDir(join(deps.tmp, `${FOLDER_PREFIX}${deps.pid}-`));
  return {
    request, deps, base: emptyResult(request.address), seconds: Math.round(timeoutMs / 1000), settleMs, settle, hard, stop, dir,
    profile: profileOf(dir),
    /* Only this call's browser knows the proxy's password: no other process on the machine uses the proxy. */
    credentials: { username: 'hh-browse', password: deps.secret() },
    left: until => Math.max(1, until - (deps.clock.now() - start)),
    proxy: null,
    context: null,
  };
}

function launchOptions(call: Call, proxy: Proxy): LaunchOptions {
  return {
    headless: true,
    /* <-loopback> sends the loopback addresses through the proxy too, which refuses them. */
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>', ...call.credentials },
    args: BROWSER_ARGS,
    viewport: VIEWPORT,
    acceptDownloads: false,
    serviceWorkers: 'block',
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: call.left(call.settleMs),
  };
}

async function launch(call: Call, proxy: Proxy): Promise<BrowserContext> {
  /* A browser that cannot even be loaded fails the call like one that cannot start. */
  const launching = Promise.resolve().then(() => call.deps.launcher().launchPersistentContext(call.profile, launchOptions(call, proxy)));
  const launched = await race(launching, call.settle.done, call.stop);
  if (launched.kind === 'done') return launched.value;
  /* A browser that starts after the call gave up on it closes at once. */
  void launching.then(late => late.close(), () => {});
  if (launched.kind === 'stopped') throw stopped(call);
  if (launched.kind === 'late') throw failed(call, `The browser did not start within the time limit of ${call.seconds} seconds.`);
  throw failed(call, `The browser could not start: ${said(launched.error)}`);
}

type Requests = ReturnType<typeof watchRequests>;

/* Where the browser was sent on to that the proxy refused. */
const sentOnTo = (proxy: Proxy, requests: Requests): Refused | undefined => proxy.refused.find(r => requests.sentTo.has(r.host));

function notOpened(call: Call, proxy: Proxy, requests: Requests, error: unknown): Ended {
  const refused = sentOnTo(proxy, requests);
  if (refused) return refusedBy(call, `The page sent the browser on to ${refused.host}, ${refused.reason}, which stays closed.`);
  if (proxy.overLimit()) return failed(call, `The page is larger than the size limit of ${sizeLimit(call)}.`);
  return failed(call, `The page could not be opened: ${said(error)}`);
}

/* The page's load, then its requests ended: the answer it came with, and whether it was still loading at the limit. */
async function open(call: Call, page: BrowserPage, proxy: Proxy, requests: Requests): Promise<{ answer: Answer; stillLoading: boolean }> {
  const went = await step(call, page.goto(call.request.address, { waitUntil: 'load', timeout: call.left(call.settleMs) }), call.settle.done);
  if (went.kind === 'error') throw notOpened(call, proxy, requests, went.error);
  const response = went.kind === 'done' ? went.value : null;
  const answer: Answer = response ? { status: response.status(), headers: response.headers() } : null;
  const closed = answer?.headers[REFUSED_HEADER];
  if (closed) throw refusedBy(call, `The page sent the browser on to ${sentOnTo(proxy, requests)?.host ?? 'an address'}, ${closed}, which stays closed.`);
  if (went.kind === 'late') return { answer, stillLoading: true };
  const settled = await step(call, requests.quiet(), call.settle.done);
  return { answer, stillLoading: settled.kind === 'late' };
}

async function waitForElement(call: Call, page: BrowserPage): Promise<string[]> {
  const selector = call.request.waitFor;
  if (!selector) return [];
  const seen = await step(call, page.waitForSelector(selector, { state: 'visible', timeout: call.left(call.settleMs) }), call.settle.done);
  return seen.kind === 'done' ? [] : [`The page showed no ${selector} within the time limit.`];
}

async function takeShot(call: Call, page: BrowserPage, height: number): Promise<{ screenshot: string | null; notes: string[] }> {
  const file = call.request.screenshot;
  if (!file) return { screenshot: null, notes: [] };
  const shot = await step(call, page.screenshot(shotOptions(call.request.fullPage, height, call.left(call.request.limits.timeoutMs))), call.hard.done);
  if (shot.kind === 'done') {
    call.deps.writeFile(file, shot.value);
    return { screenshot: file, notes: [] };
  }
  return { screenshot: null, notes: [shot.kind === 'late' ? 'The screenshot was not taken within the time limit.' : `The screenshot could not be taken: ${said(shot.error)}`] };
}

async function readPage(call: Call): Promise<BrowseResult> {
  const { request } = call;
  const proxy = (call.proxy = await startProxy({ lookup: call.deps.lookup, maxBytes: request.limits.maxBytes, credentials: call.credentials, dial: call.deps.dial, listen: call.deps.listen }));
  const context = (call.context = await launch(call, proxy));
  const first = context.pages()[0];
  const page = await must(call, first ? Promise.resolve(first) : context.newPage(), call.settle.done, () => lateRead(call), 'The browser could not open a page');
  const requests = watchRequests(context, page);
  const { answer, stillLoading } = await open(call, page, proxy, requests);
  const drawn = await step(call, page.evaluate(afterTwoFrames), call.hard.done);
  if (drawn.kind === 'late') throw lateRead(call);
  const waited = await waitForElement(call, page);
  const { maxText, maxLinks } = request.limits;
  const sample = (await must(call, page.evaluate(collectPage, { maxText, maxLinks, markers: ROBOT_MARKERS }), call.hard.done, () => lateRead(call), 'The page could not be read')) as PageSample;
  const { screenshot, notes: shotNotes } = await takeShot(call, page, sample.height);

  const finalAddress = page.url();
  const judged = judgePage({ requested: request.address, finalUrl: finalAddress, answer, sample });
  const kept = proxy.refused.filter(r => r.reason !== SIZE_LIMIT && !requests.sentTo.has(r.host));
  const notes = [
    ...(stillLoading ? ['The page was still loading at the time limit; what it showed by then is below.'] : []),
    ...waited,
    ...shotNotes,
    ...(proxy.overLimit() ? [`The page reached the size limit of ${sizeLimit(call)}; the rest of it did not load.`] : []),
    ...keptOut(kept),
    ...judged.notes,
  ];
  return {
    status: judged.status, reason: judged.reason, address: request.address, finalAddress, httpStatus: answer?.status ?? null,
    title: sample.title, text: sample.text, textLength: sample.textLength, links: sample.links, linkCount: sample.linkCount, screenshot, notes,
  };
}

export async function browse(request: BrowseRequest, deps: BrowseDeps): Promise<BrowseResult> {
  const refused = await refusal(request.address, deps.lookup);
  if (refused) return { ...emptyResult(request.address), status: 'refused', reason: `The address is refused: ${refused}.` };
  sweepStale(deps.tmp, deps.folders, deps.table, deps.uid);
  const call = begin(request, deps);
  try {
    return await readPage(call);
  } catch (error) {
    if (error instanceof Ended) return error.result;
    throw error;
  } finally {
    call.settle.cancel();
    call.hard.cancel();
    await cleanUp(call);
  }
}

/* What the page's own requests asked for that the proxy never opened. */
function keptOut(refused: Refused[]): string[] {
  if (!refused.length) return [];
  const hosts = [...new Set(refused.map(r => r.host))];
  const named = hosts.slice(0, 3);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  if (refused.length === 1) return [`The page asked for ${list}, an address that is not public; the browser did not open it.`];
  return [`The page asked for ${refused.length} addresses that are not public, such as ${list}; the browser opened none of them.`];
}

/* The browser closes, or is killed by its profile when it does not close within its allowance; then the proxy stops and
   the call's folder goes. */
async function cleanUp({ context, profile, dir, proxy, deps }: Call): Promise<void> {
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
