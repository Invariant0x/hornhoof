import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterTwoFrames, collectPage, ROBOT_MARKERS } from '../src/web-page/collect.js';

/* What collectPage asks of the browser, as a page in Chromium answers: the text the browser lays out, the elements a
   selector finds and the size each is drawn at. The test sets what the browser would know; collectPage decides the rest. */
type Box = { visibility?: string; width?: number; height?: number };
type Element = Box & { href?: string; innerText?: string; title?: string; attributes?: Record<string, string>; src?: string };
type Page = { title: string; text: string; anchors?: Element[]; frames?: Element[]; scripts?: Element[]; present?: string[]; passwords?: Element[]; scrolling?: number | null; root?: number };

function inBrowser(page: Page) {
  const shaped = (el: Element) => ({
    innerText: '',
    title: '',
    ...el,
    getAttribute: (name: string) => el.attributes?.[name] ?? null,
    getBoundingClientRect: () => ({ width: el.width ?? 10, height: el.height ?? 10 }),
  });
  const found: Record<string, Element[]> = {
    'a[href]': page.anchors ?? [],
    'iframe[src]': page.frames ?? [],
    'script[src]': page.scripts ?? [],
    'input[type=password]': page.passwords ?? [],
  };
  const root = { innerText: page.text, scrollHeight: page.root ?? 800 };
  vi.stubGlobal('document', {
    title: page.title,
    documentElement: root,
    scrollingElement: page.scrolling === null ? null : { scrollHeight: page.scrolling ?? root.scrollHeight },
    querySelectorAll: (selector: string) => (found[selector] ?? []).map(shaped),
    querySelector: (selector: string) => ((page.present ?? []).includes(selector) ? {} : null),
  });
  vi.stubGlobal('getComputedStyle', (el: Element) => ({ visibility: el.visibility ?? 'visible' }));
}

const LIMITS = { maxText: 20_000, maxLinks: 100, markers: ROBOT_MARKERS };

afterEach(() => { vi.unstubAllGlobals(); });

describe('what hh-browse reads of a page inside the browser', () => {
  it('reads the title, the text it lays out and every distinct web link once, with the words a person sees for it', () => {
    inBrowser({
      title: 'Spring catalogue',
      text: 'Spring catalogue\nHand trowel costs 12 EUR',
      anchors: [
        { href: 'https://shop.example/items/1', innerText: '  Hand\n  trowel ' },
        { href: 'https://shop.example/items/1', innerText: 'Hand trowel again' },
        { href: 'mailto:sales@shop.example', innerText: 'Write to us' },
        { href: 'javascript:void(0)', innerText: 'Menu' },
        { href: 'http://shop.example/cart', innerText: '', attributes: { 'aria-label': 'Cart' } },
        { href: 'https://shop.example/help', innerText: '', title: 'Help' },
        { href: 'https://shop.example/logo', innerText: '' },
      ],
    });
    expect(collectPage(LIMITS)).toMatchObject({
      title: 'Spring catalogue',
      text: 'Spring catalogue\nHand trowel costs 12 EUR',
      textLength: 41,
      links: [
        { text: 'Hand trowel', url: 'https://shop.example/items/1' },
        { text: 'Cart', url: 'http://shop.example/cart' },
        { text: 'Help', url: 'https://shop.example/help' },
        { text: '', url: 'https://shop.example/logo' },
      ],
      linkCount: 4,
    });
  });

  it('cuts the text and the links at their limits and still counts them whole', () => {
    inBrowser({ title: 'Long', text: 'x'.repeat(50), anchors: [1, 2, 3].map(n => ({ href: `https://shop.example/${n}`, innerText: `${'y'.repeat(300)}${n}` })) });
    const read = collectPage({ ...LIMITS, maxText: 10, maxLinks: 2 });
    expect(read).toMatchObject({ text: 'x'.repeat(10), textLength: 50, linkCount: 3 });
    expect(read.links.map(link => [link.url, link.text.length])).toEqual([['https://shop.example/1', 200], ['https://shop.example/2', 200]]);
  });

  it('names what its frames and scripts load, which robot check signs it carries, and only the password fields a person can see', () => {
    inBrowser({
      title: 'Sign in',
      text: 'Sign in',
      frames: [{ src: 'https://www.google.com/recaptcha/api2/anchor' }, { src: '' }],
      scripts: [{ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js' }],
      present: ['.cf-turnstile', '[data-sitekey]'],
      passwords: [{}, { visibility: 'hidden' }, { width: 0 }, { height: 0 }],
    });
    expect(collectPage(LIMITS)).toMatchObject({
      frames: ['https://www.google.com/recaptcha/api2/anchor'],
      scripts: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
      markers: ['.cf-turnstile', '[data-sitekey]'],
      passwordFields: 1,
    });
  });

  it('measures the page by the element that scrolls it, or by the page itself when nothing does', () => {
    inBrowser({ title: 'Tall', text: '', scrolling: 4200, root: 800 });
    expect(collectPage(LIMITS).height).toBe(4200);
    inBrowser({ title: 'Plain', text: '', scrolling: null, root: 900 });
    expect(collectPage(LIMITS).height).toBe(900);
  });

  it('is done once the browser drew two frames', async () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (draw: () => void) => frames.push(draw));
    let done = false;
    const waiting = afterTwoFrames().then(() => { done = true; });
    frames.shift()!();
    await Promise.resolve();
    expect(done).toBe(false);
    frames.shift()!();
    await waiting;
    expect(done).toBe(true);
  });
});
