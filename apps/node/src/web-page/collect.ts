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
  const shown = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
  };
  const body = document.body as HTMLElement | null;
  const text = body ? body.innerText : '';
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const url = a.href;
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    if (links.length >= maxLinks) continue;
    const label = a.innerText || a.getAttribute('aria-label') || a.title || '';
    links.push({ text: label.replace(/\s+/g, ' ').trim().slice(0, 200), url });
  }
  const sources = (selector: string): string[] =>
    Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLScriptElement>(selector)).map(el => el.src).filter(Boolean).slice(0, 100);
  return {
    title: document.title,
    text: text.slice(0, maxText),
    textLength: text.length,
    links,
    linkCount: seen.size,
    frames: sources('iframe[src]'),
    scripts: sources('script[src]'),
    markers: markers.filter(selector => document.querySelector(selector) !== null),
    passwordFields: Array.from(document.querySelectorAll('input[type=password]')).filter(shown).length,
    height: Math.max(document.documentElement.scrollHeight, body ? body.scrollHeight : 0),
  };
}

/* Two frames drawn: what the page's scripts changed last is on the screen. */
export function afterTwoFrames(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
