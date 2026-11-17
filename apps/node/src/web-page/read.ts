import type { PageLink, PageSample } from './collect.js';

/* What a page read in the browser comes to. A sign-in or a robot check is no failure of the call: the page was reached, and
   what stands in the way is for a person, as hh-browse signs in nowhere and gets past no check. */

type PageStatus = 'ok' | 'login_required' | 'robot_check' | 'http_error' | 'refused' | 'failed';
export type Answer = { status: number; headers: Record<string, string> } | null;
type Judgement = { status: PageStatus; reason: string | null; notes: string[] };
export type BrowseResult = {
  status: PageStatus;
  reason: string | null;
  address: string;
  finalAddress: string | null;
  httpStatus: number | null;
  title: string | null;
  text: string | null;
  textLength: number;
  links: PageLink[];
  linkCount: number;
  screenshot: string | null;
  notes: string[];
};

/* Shorter than this, a page is little more than what it shows a visitor at its door. */
const SHORT = 2000;
const GATE = 400;
const CHALLENGES = new Set(['#challenge-form', '#challenge-running', '#cf-challenge-running', '#px-captcha']);
const WIDGETS = new Set(['.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]']);
/* Services that show a check of their own in place of the page; the widget services also sit on ordinary forms. */
const CHALLENGE_SOURCES = /^https?:\/\/(?:[^/]*\.)?(?:captcha-delivery\.com|perimeterx\.net|px-cloud\.net|arkoselabs\.com|funcaptcha\.com)\//i;
const WIDGET_SOURCES = /^https?:\/\/(?:[^/]*\.)?(?:google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|geetest\.com)/i;
const ROBOT_TITLE = /^(?:just a moment|attention required|security check|checking your browser|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|one more step|pardon our interruption)/i;
const ROBOT_TEXT = /verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|not a robot|unusual traffic|checking (?:if the site connection is secure|your browser)|press (?:&|and) hold|complete the security check|confirm you are (?:a )?human/i;
const LOGIN_PATH = /\/(?:log-?in|sign-?in|sign_in|auth|authenticate|sso|session\/new|wp-login\.php|oauth2?\/authorize)(?=[/?#.]|$)/i;
const LOGIN_WORDS = /sign in|sign-in|log in|log-in|login|войти|вход/i;

const pathOf = (address: string): string => {
  try {
    return new URL(address).pathname;
  } catch {
    return '';
  }
};

const CHECKS_FIRST = 'The page checks that a person is there before it shows anything.';
const SIGN_IN = 'The page asks to sign in.';
const WIDGET_NOTE = 'The page has a robot check widget, probably on a form; the page itself was read.';
const judged = (status: PageStatus, reason: string): Judgement => ({ status, reason, notes: [] });

/* The answer's status and its headers by lower-case name; a page the browser shows without an answer has neither. */
function answered(answer: Answer): { status: number | null; headers: Record<string, string> } {
  if (!answer) return { status: null, headers: {} };
  return { status: answer.status, headers: Object.fromEntries(Object.entries(answer.headers).map(([name, value]) => [name.toLowerCase(), value])) };
}

/* A check that stands in place of the page: one the site says it shows, or one the page itself is. */
function challenged(sample: PageSample): boolean {
  const sources = [...sample.frames, ...sample.scripts];
  return sample.markers.some(m => CHALLENGES.has(m)) || sources.some(s => CHALLENGE_SOURCES.test(s)) || ROBOT_TITLE.test(sample.title.trim()) || (sample.textLength < SHORT && ROBOT_TEXT.test(sample.text));
}

function robotReason(status: number | null, headers: Record<string, string>, sample: PageSample): string | null {
  if (headers['cf-mitigated'] === 'challenge') return 'The site shows a check that a person is there.';
  if (status === 429) return 'The site answered 429: too many requests from this machine.';
  return challenged(sample) ? CHECKS_FIRST : null;
}

/* A short page with a password field a person sees, a password field on a sign-in address, or a sign-in address the page
   was sent on to or that names a sign-in. */
function asksToSignIn(requested: string, finalUrl: string, sample: PageSample): boolean {
  const path = pathOf(finalUrl);
  const loginPath = LOGIN_PATH.test(path);
  if (sample.passwordFields > 0 && (sample.textLength < SHORT || loginPath)) return true;
  return loginPath && (path !== pathOf(requested) || LOGIN_WORDS.test(sample.title) || LOGIN_WORDS.test(sample.text.slice(0, 600)));
}

function loginReason(status: number | null, requested: string, finalUrl: string, sample: PageSample): string | null {
  if (status === 401 || status === 407) return `The site answered ${status}: it asks to sign in.`;
  return asksToSignIn(requested, finalUrl, sample) ? SIGN_IN : null;
}

/* A robot check widget, which also sits on ordinary forms. */
function hasWidget(sample: PageSample): boolean {
  return sample.markers.some(m => WIDGETS.has(m)) || [...sample.frames, ...sample.scripts].some(s => WIDGET_SOURCES.test(s));
}

export function judgePage({ requested, finalUrl, answer, sample }: { requested: string; finalUrl: string; answer: Answer; sample: PageSample }): Judgement {
  const { status, headers } = answered(answer);
  const robot = robotReason(status, headers, sample);
  if (robot) return judged('robot_check', robot);
  const login = loginReason(status, requested, finalUrl, sample);
  if (login) return judged('login_required', login);
  const widget = hasWidget(sample);
  if (widget && sample.textLength < GATE) return judged('robot_check', CHECKS_FIRST);
  if (status !== null && status >= 400) return judged('http_error', `The site answered ${status}.`);
  return { status: 'ok', reason: null, notes: widget ? [WIDGET_NOTE] : [] };
}

const NEXT: Partial<Record<PageStatus, string>> = {
  login_required: 'Never try to get past it, and ask nobody for a way in. Note this address and what it asks for in your report for a person, and go on with the other addresses.',
  robot_check: 'Never try to get past it, and ask nobody for a way in. Note this address and what it asks for in your report for a person, and go on with the other addresses.',
  refused: 'This address stays refused: go on with the other addresses.',
  failed: 'Try the address once more if the reason allows it; otherwise note it for a person and go on with the other addresses.',
};

const when = (yes: unknown, line: string): string[] => (yes ? [line] : []);

function headLines(r: BrowseResult): string[] {
  return [
    `Status: ${r.status}`,
    ...when(r.reason, `Reason: ${r.reason}`),
    `Address: ${r.address}`,
    ...when(r.finalAddress && r.finalAddress !== r.address, `Final address: ${r.finalAddress}`),
    ...when(r.httpStatus !== null, `HTTP status: ${r.httpStatus}`),
    ...when(r.title, `Title: ${r.title}`),
    ...r.notes.map(note => `Note: ${note}`),
    ...when(r.screenshot, `Screenshot: ${r.screenshot} (show it to a person with hh-attach FILE, or put it on a task with hh-attach --task N FILE)`),
    ...when(NEXT[r.status], `Next: ${NEXT[r.status]}`),
  ];
}

function linkLines(r: BrowseResult): string[] {
  if (!r.links.length) return [r.linkCount ? `Links: ${r.linkCount}, none shown; --max-links shows them.` : 'Links: none'];
  const count = r.linkCount > r.links.length ? `${r.links.length} of ${r.linkCount}` : `${r.linkCount}`;
  return [`Links (${count}):`, ...r.links.map(link => (link.text ? `- ${link.text}: ${link.url}` : `- ${link.url}`))];
}

function textLines(r: BrowseResult): string[] {
  if (r.text === null) return [];
  const size = r.textLength > r.text.length ? `first ${r.text.length} of ${r.textLength} characters` : `${r.textLength} characters`;
  return ['', `Text (${size}):`, r.text, '', ...linkLines(r)];
}

/* The result as an agent reads it in its terminal. */
export function formatResult(r: BrowseResult): string {
  return `${[...headLines(r), ...textLines(r)].join('\n')}\n`;
}

/* 0: the page was reached and its status says what it holds. 2: the address is refused. 1: the call failed. */
export function exitCode(status: PageStatus): number {
  if (status === 'refused') return 2;
  return status === 'failed' ? 1 : 0;
}
