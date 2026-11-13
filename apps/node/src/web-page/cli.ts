import { randomBytes } from 'node:crypto';
import { lookup as resolveName } from 'node:dns/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
its scripts build, and prints its visible text and its links. It signs in nowhere and gets past no robot check.

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

const VALUED: Record<string, Limit | 'screenshot' | 'waitFor'> = {
  '--screenshot': 'screenshot', '--wait-for': 'waitFor', '--timeout': 'timeout', '--max-text': 'text', '--max-links': 'links', '--max-mb': 'megabytes',
};

export function parseArgs(argv: string[]): Parsed {
  const addresses: string[] = [];
  const set: { screenshot: string | null; waitFor: string | null; fullPage: boolean; json: boolean } = { screenshot: null, waitFor: null, fullPage: false, json: false };
  const limits: Record<Limit, number> = { timeout: LIMITS.timeout.fallback, text: LIMITS.text.fallback, links: LIMITS.links.fallback, megabytes: LIMITS.megabytes.fallback };
  const words = argv.flatMap(word => (/^--[\w-]+=/.test(word) ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word]));
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--help' || word === '-h') return { kind: 'help' };
    if (word === '--json') set.json = true;
    else if (word === '--full-page') set.fullPage = true;
    else if (VALUED[word]) {
      const value = words[++i];
      if (value === undefined) return { kind: 'error', message: `${word} needs a value.` };
      const key = VALUED[word];
      if (key === 'screenshot') {
        if (!/\.png$/i.test(value)) return { kind: 'error', message: '--screenshot needs a file name that ends in .png.' };
        set.screenshot = resolve(value);
      } else if (key === 'waitFor') set.waitFor = value;
      else {
        const { min, max } = LIMITS[key];
        const n = /^\d+$/.test(value) ? Number(value) : NaN;
        if (!(n >= min && n <= max)) return { kind: 'error', message: `${word} must be a whole number from ${min} to ${max}.` };
        limits[key] = n;
      }
    } else if (word.startsWith('-')) return { kind: 'error', message: `hh-browse has no option ${word}.` };
    else addresses.push(word);
  }
  if (addresses.length !== 1) return { kind: 'error', message: 'Give one address, such as https://example.org/.' };
  return {
    kind: 'browse',
    json: set.json,
    request: {
      address: addresses[0]!, screenshot: set.screenshot, fullPage: set.fullPage, waitFor: set.waitFor,
      limits: { timeoutMs: limits.timeout * 1000, maxText: limits.text, maxLinks: limits.links, maxBytes: limits.megabytes * 1024 * 1024 },
    },
  };
}

type Io = { out(text: string): void; err(text: string): void };
type Run = (request: BrowseRequest) => Promise<BrowseResult>;

export async function main(argv: string[], io: Io, run: Run = request => browse(request, systemDeps())): Promise<number> {
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
const IMAGE_PLAYWRIGHT = '/usr/local/lib/node_modules/playwright';
const IMAGE_BROWSERS = ['/data/browsers', '/opt/ms-playwright'];

function chromium(): Launcher {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= IMAGE_BROWSERS.find(dir => existsSync(dir)) ?? IMAGE_BROWSERS[0]!;
  const from = existsSync(join(IMAGE_PLAYWRIGHT, 'package.json')) ? join(IMAGE_PLAYWRIGHT, 'package.json') : import.meta.url;
  return (createRequire(from)('playwright-core') as { chromium: Launcher }).chromium;
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

/* The command itself: a stop of the terminal or the agent's program ends the call, with its browser, before it exits. */
export async function run(argv: string[]): Promise<void> {
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => stop.abort());
  const code = await main(argv, { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }, request => browse({ ...request, signal: stop.signal }, systemDeps()));
  process.exit(code);
}
