/* What a page shows, read inside the browser. Playwright sends these functions to the page as their source text, so they
   use nothing from outside themselves and only what every browser has. */

export type PageLink = { text: string; url: string };
/* text: the visible text, cut at maxText characters, and textLength its whole length. linkCount: every distinct http and
   https link, of which links holds the first maxLinks. frames and scripts: what iframes and scripts of the page load.
   markers: the signs of a robot check the page carries. passwordFields: the password fields a person can see. */
export type PageSample = {
  title: string;
  text: string;
  textLength: number;
  links: PageLink[];
  linkCount: number;
  frames: string[];
  scripts: string[];
  markers: string[];
  passwordFields: number;
  height: number;
};

export const ROBOT_MARKERS = ['.g-recaptcha', '.h-captcha', '.cf-turnstile', '#challenge-form', '#challenge-running', '#cf-challenge-running', '#px-captcha', '[data-sitekey]'];

export function collectPage({ maxText, maxLinks, markers }: { maxText: number; maxLinks: number; markers: string[] }): PageSample {
  const root = document.documentElement;
  const text = root.innerText;
  const seen = new Set<string>();
  /* Each http and https address once, under the words of its first link. */
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(a => /^https?:/i.test(a.href) && !seen.has(a.href) && seen.add(a.href));
  const label = (a: HTMLAnchorElement): string => a.innerText || a.getAttribute('aria-label') || a.title;
  const sources = (selector: string): string[] =>
    Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLScriptElement>(selector)).map(el => el.src).filter(Boolean).slice(0, 100);
  /* What a person can see: drawn with a size, and not hidden. */
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return getComputedStyle(el).visibility !== 'hidden' && box.width * box.height > 0;
  };
  return {
    title: document.title,
    text: text.slice(0, maxText),
    textLength: text.length,
    links: anchors.slice(0, maxLinks).map(a => ({ text: label(a).replace(/\s+/g, ' ').trim().slice(0, 200), url: a.href })),
    linkCount: anchors.length,
    frames: sources('iframe[src]'),
    scripts: sources('script[src]'),
    markers: markers.filter(selector => document.querySelector(selector) !== null),
    passwordFields: Array.from(document.querySelectorAll('input[type=password]')).filter(shown).length,
    height: (document.scrollingElement ?? root).scrollHeight,
  };
}

/* Two frames drawn: what the page's scripts changed last is on the screen. */
export function afterTwoFrames(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
