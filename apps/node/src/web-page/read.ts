import type { PageLink, PageSample } from './collect.js';

/* What a page read in the browser comes to. A sign-in or a robot check is no failure of the call: the page was reached, and
   what stands in the way is for a person, as hh-browse signs in nowhere and gets past no check. */

export type PageStatus = 'ok' | 'login_required' | 'robot_check' | 'http_error' | 'refused' | 'failed';
export type Answer = { status: number; headers: Record<string, string> } | null;
export type Judgement = { status: PageStatus; reason: string | null; notes: string[] };
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

const robot = (reason: string): Judgement => ({ status: 'robot_check', reason, notes: [] });
const login = (reason: string): Judgement => ({ status: 'login_required', reason, notes: [] });

export function judgePage({ requested, finalUrl, answer, sample }: { requested: string; finalUrl: string; answer: Answer; sample: PageSample }): Judgement {
  const status = answer?.status ?? null;
  const headers = Object.fromEntries(Object.entries(answer?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const sources = [...sample.frames, ...sample.scripts];
  const short = sample.textLength < SHORT;

  if (headers['cf-mitigated'] === 'challenge') return robot('The site shows a check that a person is there.');
  if (status === 429) return robot('The site answered 429: too many requests from this machine.');
  if (sample.markers.some(m => CHALLENGES.has(m)) || sources.some(s => CHALLENGE_SOURCES.test(s)) || ROBOT_TITLE.test(sample.title.trim()) || (short && ROBOT_TEXT.test(sample.text))) {
    return robot('The page checks that a person is there before it shows anything.');
  }

  if (status === 401 || status === 407) return login(`The site answered ${status}: it asks to sign in.`);
  const path = pathOf(finalUrl);
  const loginPath = LOGIN_PATH.test(path);
  if (sample.passwordFields > 0 && (short || loginPath)) return login('The page asks to sign in.');
  if (loginPath && (path !== pathOf(requested) || LOGIN_WORDS.test(sample.title) || LOGIN_WORDS.test(sample.text.slice(0, 600)))) return login('The page asks to sign in.');

  const widget = sample.markers.some(m => WIDGETS.has(m)) || sources.some(s => WIDGET_SOURCES.test(s));
  if (widget && sample.textLength < GATE) return robot('The page checks that a person is there before it shows anything.');
  if (status !== null && status >= 400) return { status: 'http_error', reason: `The site answered ${status}.`, notes: [] };
  return { status: 'ok', reason: null, notes: widget ? ['The page has a robot check widget, probably on a form; the page itself was read.'] : [] };
}

const NEXT: Partial<Record<PageStatus, string>> = {
  login_required: 'Never try to get past it, and ask nobody for a way in. Note this address and what it asks for in your report for a person, and go on with the other addresses.',
  robot_check: 'Never try to get past it, and ask nobody for a way in. Note this address and what it asks for in your report for a person, and go on with the other addresses.',
  refused: 'This address stays refused: go on with the other addresses.',
  failed: 'Try the address once more if the reason allows it; otherwise note it for a person and go on with the other addresses.',
};

/* The result as an agent reads it in its terminal. */
export function formatResult(r: BrowseResult): string {
  const lines = [`Status: ${r.status}`];
  if (r.reason) lines.push(`Reason: ${r.reason}`);
  lines.push(`Address: ${r.address}`);
  if (r.finalAddress && r.finalAddress !== r.address) lines.push(`Final address: ${r.finalAddress}`);
  if (r.httpStatus !== null) lines.push(`HTTP status: ${r.httpStatus}`);
  if (r.title) lines.push(`Title: ${r.title}`);
  for (const note of r.notes) lines.push(`Note: ${note}`);
  if (r.screenshot) lines.push(`Screenshot: ${r.screenshot} (show it to a person with hh-attach FILE, or put it on a task with hh-attach --task N FILE)`);
  if (NEXT[r.status]) lines.push(`Next: ${NEXT[r.status]}`);
  if (r.text !== null) {
    const size = r.textLength > r.text.length ? `first ${r.text.length} of ${r.textLength} characters` : `${r.textLength} characters`;
    lines.push('', `Text (${size}):`, r.text);
    const count = r.linkCount > r.links.length ? `${r.links.length} of ${r.linkCount}` : `${r.linkCount}`;
    if (r.links.length) lines.push('', `Links (${count}):`);
    else lines.push('', r.linkCount ? `Links: ${r.linkCount}, none shown; --max-links shows them.` : 'Links: none');
    for (const link of r.links) lines.push(link.text ? `- ${link.text}: ${link.url}` : `- ${link.url}`);
  }
  return `${lines.join('\n')}\n`;
}

/* 0: the page was reached and its status says what it holds. 2: the address is refused. 1: the call failed. */
export function exitCode(status: PageStatus): number {
  if (status === 'refused') return 2;
  return status === 'failed' ? 1 : 0;
}
