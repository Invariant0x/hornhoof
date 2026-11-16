import { randomBytes } from 'node:crypto';
import { lookup as resolveName } from 'node:dns/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { browseAsAgent, type AgentBrowseDeps } from './agent.js';
import { browse, realClock, type BrowseDeps, type BrowseRequest, type Launcher } from './browse.js';
import { systemFolders, systemProcesses } from './processes.js';
import { exitCode, formatResult, type BrowseResult } from './read.js';

/* hh-browse URL: what an agent of any department runs on its node to read a page in a browser. */

/* Each limit an agent may set, with its default; outside its range a call is refused, not cut. */
export const LIMITS = {
  timeout: { fallback: 30, min: 5, max: 120 },
  text: { fallback: 20_000, min: 1000, max: 200_000 },
  links: { fallback: 100, min: 0, max: 1000 },
  megabytes: { fallback: 20, min: 1, max: 100 },
} as const;
type Limit = keyof typeof LIMITS;

const range = (limit: Limit) => `${LIMITS[limit].min} to ${LIMITS[limit].max}, ${LIMITS[limit].fallback} by default`;

export const USAGE = `Usage: hh-browse [options] URL

Opens one public http or https address in a real browser on this machine, waits until the page has loaded and drawn what
its scripts build, and prints its visible text and its links. It types no password and gets past no robot check. In a
Hornhoof turn, a sign-in a person saved for you opens the pages of its site, read in your machine's own browser.

Options:
  --screenshot FILE.png  also save a picture of the page; show it to a person with hh-attach FILE, or put it on a task
                         with hh-attach --task N FILE
  --full-page            picture the whole page, not only its first screen (at most 10000 pixels high)
  --wait-for CSS         also wait until an element that matches CSS shows
  --json                 print the result as JSON
  --timeout SECONDS      time limit of the call, ${range('timeout')}
  --max-text CHARS       characters of text printed, ${range('text')}
  --max-links N          links printed, ${range('links')}
  --max-mb MB            what the page may load in all, in MB, ${range('megabytes')}

Status: ok; login_required, the site asks to sign in; robot_check, the site checks that a person is there; http_error;
refused, the address is not public; failed. Exit code: 0 when the page was reached, 2 when the address is refused or
the call is wrong, 1 when the call failed.
`;

export type Parsed = { kind: 'help' } | { kind: 'error'; message: string } | { kind: 'browse'; request: BrowseRequest; json: boolean };

/* The options that take a value, and what each sets. A Map, so that no word an object of JavaScript knows counts as one. */
const VALUED = new Map<string, Limit | 'screenshot' | 'waitFor'>([
  ['--screenshot', 'screenshot'], ['--wait-for', 'waitFor'], ['--timeout', 'timeout'], ['--max-text', 'text'], ['--max-links', 'links'], ['--max-mb', 'megabytes'],
]);

type Settings = { addresses: string[]; screenshot: string | null; waitFor: string | null; fullPage: boolean; json: boolean; limits: Record<Limit, number> };

/* --name=value as two words. */
const wordsOf = (argv: string[]): string[] =>
  argv.flatMap(word => (/^--[\w-]+=/.test(word) ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word]));

/* Each setter answers with what is wrong, or null. */
function setLimit(set: Settings, limit: Limit, word: string, value: string): string | null {
  const { min, max } = LIMITS[limit];
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) return `${word} must be a whole number from ${min} to ${max}.`;
  set.limits[limit] = n;
  return null;
}

function setScreenshot(set: Settings, value: string): string | null {
  if (!/\.png$/i.test(value)) return '--screenshot needs a file name that ends in .png.';
  set.screenshot = resolve(value);
  return null;
}

function setValue(set: Settings, word: string, value: string | undefined): string | null {
  if (value === undefined) return `${word} needs a value.`;
  const key = VALUED.get(word)!;
  if (key === 'screenshot') return setScreenshot(set, value);
  if (key !== 'waitFor') return setLimit(set, key, word, value);
  set.waitFor = value;
  return null;
}

function setWord(set: Settings, word: string): string | null {
  if (word === '--json') set.json = true;
  else if (word === '--full-page') set.fullPage = true;
  else if (word.startsWith('-')) return `hh-browse has no option ${word}.`;
  else set.addresses.push(word);
  return null;
}

export function parseArgs(argv: string[]): Parsed {
  const set: Settings = {
    addresses: [], screenshot: null, waitFor: null, fullPage: false, json: false,
    limits: { timeout: LIMITS.timeout.fallback, text: LIMITS.text.fallback, links: LIMITS.links.fallback, megabytes: LIMITS.megabytes.fallback },
  };
  const words = wordsOf(argv);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--help' || word === '-h') return { kind: 'help' };
    const wrong = VALUED.has(word) ? setValue(set, word, words[++i]) : setWord(set, word);
    if (wrong) return { kind: 'error', message: wrong };
  }
  if (set.addresses.length !== 1) return { kind: 'error', message: 'Give one address, such as https://example.org/.' };
  const { timeout, text, links, megabytes } = set.limits;
  return {
    kind: 'browse',
    json: set.json,
    request: {
      address: set.addresses[0]!, screenshot: set.screenshot, fullPage: set.fullPage, waitFor: set.waitFor,
      limits: { timeoutMs: timeout * 1000, maxText: text, maxLinks: links, maxBytes: megabytes * 1024 * 1024 },
    },
  };
}

type Io = { out(text: string): void; err(text: string): void };
type Run = (request: BrowseRequest) => Promise<BrowseResult>;

export async function main(argv: string[], io: Io, run: Run = request => browseAsAgent(request, agentDeps())): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    io.err(`hh-browse: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const result = await run(parsed.request);
  io.out(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
  return exitCode(result.status);
}

/* The image's own Playwright and browsers, which the node keeps ready; nothing is installed for a call. */
const IMAGE_PLAYWRIGHT = '/usr/local/lib/node_modules/playwright/package.json';
const IMAGE_BROWSERS = ['/data/browsers', '/opt/ms-playwright'];

export const browsersPath = (exists: (path: string) => boolean): string => IMAGE_BROWSERS.find(exists) ?? IMAGE_BROWSERS[0]!;
/* Where playwright-core is looked up from: the image's Playwright, else beside this file. */
export const playwrightFrom = (exists: (path: string) => boolean): string => (exists(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : import.meta.url);

function chromium(): Launcher {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= browsersPath(existsSync);
  return (createRequire(playwrightFrom(existsSync))('playwright-core') as { chromium: Launcher }).chromium;
}

export function systemDeps(): BrowseDeps {
  return {
    launcher: chromium,
    lookup: async host => (await resolveName(host, { all: true, verbatim: true })).map(found => found.address),
    clock: realClock,
    tmp: tmpdir(),
    uid: process.getuid?.() ?? -1,
    pid: process.pid,
    table: systemProcesses,
    folders: systemFolders,
    makeDir: prefix => mkdtempSync(prefix),
    removeDir: path => rmSync(path, { recursive: true, force: true }),
    writeFile: (path, bytes) => writeFileSync(path, bytes),
    secret: () => randomBytes(24).toString('hex'),
  };
}

/* In a turn, Hornhoof is asked first for a sign-in saved for the agent; the page is read here when there is none. */
export function agentDeps(env: NodeJS.ProcessEnv = process.env): AgentBrowseDeps {
  return { url: env.HH_ATTACH_URL, pass: env.HH_ATTACH_PASS, fetch: (url, init) => fetch(url, init), local: request => browse(request, systemDeps()), writeFile: (path, bytes) => writeFileSync(path, bytes) };
}

/* The command itself: a stop of the terminal or the agent's program ends the call, with its browser, before it exits. */
export async function run(argv: string[]): Promise<void> {
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => stop.abort());
  const code = await main(argv, { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }, request => browseAsAgent({ ...request, signal: stop.signal }, agentDeps()));
  process.exit(code);
}
