import { join } from 'node:path';
import type { Server } from 'node:http';
import { FILL_SHOT_MAX, sameSite, SiteSession, type FillField, type FillStatus } from '@hornhoof/protocol';
import { checkAddress, vetHost, type Lookup } from '../web-page/address.js';
import { ROBOT_MARKERS } from '../web-page/collect.js';
import { FOLDER_PREFIX, profileOf, reapProfile, sweepStale, type Folders, type ProcessTable } from '../web-page/processes.js';
import { startProxy, type Dial, type Proxy } from '../web-page/proxy.js';
import type { FillAdapter, FillReceipt, FillValues, TargetOf } from './index.js';

/* A vault sign-in in the node's own browser: Chromium of the node's process, never of an agent, so no value enters a
   process an agent controls. It opens the entry's page through the same proxy and address checks as hh-browse, types
   each step the page shows (login, password, one-time code) and sends it, and keeps the sign-in it got for hh-browse. It
   types only on pages of the entry's site, changes nothing of what the browser shows a site, and passes no robot check:
   a site that refuses an automated browser gets a person or a phone instead. */

export type FillLocator = {
  readonly selector: string;
  fill(value: string, options: { timeout: number }): Promise<void>;
  press(key: 'Enter', options: { timeout: number }): Promise<void>;
};
export type FillPage = {
  url(): string;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  evaluate(fn: (markers: SignInMarkers) => SignInFacts, arg: SignInMarkers): Promise<unknown>;
  locator(selector: string): FillLocator;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
  screenshot(options: { type: 'png'; timeout: number; mask: FillLocator[]; maskColor: string }): Promise<Buffer>;
};
export type FillContext = { pages(): FillPage[]; newPage(): Promise<FillPage>; storageState(): Promise<unknown>; close(): Promise<void> };
export type FillLauncher = { launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<FillContext> };

export type BrowserFillDeps = {
  launcher(): FillLauncher;
  lookup: Lookup;
  tmp: string;
  uid: number;
  pid: number;
  table: ProcessTable;
  folders: Folders;
  makeDir(prefix: string): string;
  removeDir(path: string): void;
  secret(): string;
  dial?: Dial;
  listen?: (server: Server) => Promise<number>;
};

/* Login, password and code steps, with room for a page that asks twice. */
const MAX_STEPS = 5;
const STEP_MS = 10_000;
const CLOSE_MS = 5000;
const VIEWPORT = { width: 1280, height: 800 };
const MAX_BYTES = 20 * 1024 * 1024;
const SELECTOR: Record<FillField, string> = { login: '[data-hh-fill="login"]', password: '[data-hh-fill="password"]', code: '[data-hh-fill="code"]' };
/* What a screenshot paints over: every field the page marked for signing in, and any password field. */
const MASKED = ['[data-hh-fill]', 'input[type=password]'];

/* Words of pages that turn an automated browser away, as such sites write them. */
const REFUSED_WORDS = ['this browser or app may not be secure', 'browser is not supported', "couldn't sign you in", 'этот браузер или приложение могут быть небезопасны', 'не удалось войти'];

export type SignInMarkers = { robot: string[]; refused: string[] };
export type SignInFacts = { login: boolean; password: boolean; code: boolean; robot: boolean; refused: boolean };

/* Runs in the page: finds the visible sign-in fields, marks them for the steps that type into them, and tells whether a
   robot check or a page that refuses the browser is shown. */
export function signInFacts({ robot, refused }: SignInMarkers): SignInFacts {
  for (const marked of Array.from(document.querySelectorAll('[data-hh-fill]'))) marked.removeAttribute('data-hh-fill');
  const shown = (el: HTMLInputElement) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled && !el.readOnly;
  };
  const inputs = Array.from(document.querySelectorAll('input')).filter(shown);
  const words = (el: HTMLInputElement) => [el.name, el.id, el.autocomplete, el.getAttribute('aria-label') ?? '', el.placeholder].join(' ').toLowerCase();
  const password = inputs.find(el => el.type === 'password');
  const code = inputs.find(el => el.type !== 'password' && (el.autocomplete === 'one-time-code' || /\b(otp|totp|2fa|mfa|one.?time|verification|code)\b/.test(words(el))));
  const login = inputs.find(el => el !== code && ['email', 'text', 'tel'].includes(el.type) && (/username|email/.test(el.autocomplete) || el.type === 'email' || /user|login|email|account|identifier/.test(words(el))));
  if (login) login.setAttribute('data-hh-fill', 'login');
  if (password) password.setAttribute('data-hh-fill', 'password');
  if (code) code.setAttribute('data-hh-fill', 'code');
  const text = (document.body?.innerText ?? '').toLowerCase();
  return {
    login: Boolean(login),
    password: Boolean(password),
    code: Boolean(code),
    robot: robot.some(selector => document.querySelector(selector) !== null),
    refused: refused.some(word => text.includes(word)),
  };
}

type Call = { deps: BrowserFillDeps; dir: string; proxy: Proxy | null; context: FillContext | null };

async function refused(address: string, lookup: Lookup): Promise<boolean> {
  const checked = checkAddress(address);
  if (!checked.ok) return true;
  return !(await vetHost(checked.url.hostname, lookup)).ok;
}

async function launch(call: Call): Promise<FillPage> {
  const credentials = { username: 'hh-fill', password: call.deps.secret() };
  const proxy = (call.proxy = await startProxy({ lookup: call.deps.lookup, maxBytes: MAX_BYTES, credentials, dial: call.deps.dial, listen: call.deps.listen }));
  call.context = await call.deps.launcher().launchPersistentContext(profileOf(call.dir), {
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>', ...credentials },
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    viewport: VIEWPORT,
    acceptDownloads: false,
    serviceWorkers: 'block',
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: STEP_MS,
  });
  return call.context.pages()[0] ?? (await call.context.newPage());
}

async function cleanUp(call: Call): Promise<void> {
  if (call.context) await Promise.race([call.context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, CLOSE_MS).unref())]);
  reapProfile(profileOf(call.dir), call.deps.table, call.deps.uid);
  await call.proxy?.close();
  try {
    call.deps.removeDir(call.dir);
  } catch {
    /* The next call removes it. */
  }
}

/* A picture of where the sign-in stopped, every sign-in field painted over before it leaves the browser. */
async function shotOf(page: FillPage): Promise<string | undefined> {
  try {
    const png = await page.screenshot({ type: 'png', timeout: STEP_MS, mask: MASKED.map(s => page.locator(s)), maskColor: '#000000' });
    const text = png.toString('base64');
    return text.length <= FILL_SHOT_MAX ? text : undefined;
  } catch {
    return undefined;
  }
}

async function sessionOf(context: FillContext): Promise<SiteSession | undefined> {
  const parsed = SiteSession.safeParse(await context.storageState().catch(() => null));
  return parsed.success ? parsed.data : undefined;
}

async function settle(page: FillPage): Promise<void> {
  await page.waitForLoadState('load', { timeout: STEP_MS }).catch(() => {});
}

function stopped(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('The sign-in ran out of time.');
}

async function steps(page: FillPage, context: FillContext, address: string, values: FillValues, fields: FillField[], signal: AbortSignal): Promise<FillReceipt> {
  const filled: FillField[] = [];
  const end = async (status: FillStatus): Promise<FillReceipt> => {
    const shot = await shotOf(page);
    const session = status === 'signed_in' ? await sessionOf(context) : undefined;
    return { status, filled, ...(shot ? { shot } : {}), ...(session ? { session } : {}) };
  };
  await page.goto(address, { waitUntil: 'load', timeout: STEP_MS });
  let sent: FillField[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    stopped(signal);
    const facts = (await page.evaluate(signInFacts, { robot: ROBOT_MARKERS, refused: REFUSED_WORDS })) as SignInFacts;
    if (facts.robot) return end('robot_check');
    if (facts.refused) return end('browser_refused');
    const shown = (['login', 'password', 'code'] as const).filter(f => facts[f]);
    if (!shown.length) return end(filled.length ? 'signed_in' : 'field_not_found');
    if (!sameSite(address, page.url())) return end('needs_person');
    const now = shown.filter(f => fields.includes(f) && !filled.includes(f));
    if (!now.length) return end(shown.some(f => sent.includes(f)) ? 'rejected' : 'needs_person');
    for (const field of now) {
      const value = field === 'code' ? values.code() : values[field];
      if (!value) return end('field_not_found');
      await value.reveal(plain => page.locator(SELECTOR[field]).fill(plain, { timeout: STEP_MS }));
      filled.push(field);
    }
    sent = now;
    await page.locator(SELECTOR[now.at(-1)!]).press('Enter', { timeout: STEP_MS });
    await settle(page);
  }
  return end('needs_person');
}

export function browserFillAdapter(deps: BrowserFillDeps): FillAdapter<'browser'> {
  return {
    kind: 'browser',
    /* The browser is this fill's own and closes with it: nothing else pictures it while values go in. */
    shield: async () => async () => {},
    fill: async (target: TargetOf<'browser'>, values, fields, signal) => {
      if (await refused(target.address, deps.lookup)) return { status: 'failed', filled: [] };
      sweepStale(deps.tmp, deps.folders, deps.table, deps.uid);
      const call: Call = { deps, dir: deps.makeDir(join(deps.tmp, `${FOLDER_PREFIX}${deps.pid}-`)), proxy: null, context: null };
      try {
        const page = await launch(call);
        return await steps(page, call.context!, target.address, values, fields, signal);
      } finally {
        await cleanUp(call);
      }
    },
  };
}
