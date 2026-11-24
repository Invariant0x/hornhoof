import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../src/connection';
import { LanguageProvider } from '../src/i18n';
import { ConnectionLayer } from '../src/ui/ConnectionLayer';
import { decl } from './css';

/* The layer over the page while the server is away (#2049): the Hornhoof sign and one line in English, "No connection" or
   "Updating", on a plain background, and nothing else: no hint, counter, ring, button or second language. It goes by
   itself once the server answers. */

const up = () => new Response(JSON.stringify({ build: 'b1' }), { status: 200 });
const refused = () => {
  throw new TypeError('Failed to fetch');
};
const maintenance = () => new Response(JSON.stringify({ error: { code: 'unavailable', message: 'x', reason: 'maintenance' } }), { status: 503 });

let answer: () => Response;

beforeEach(() => {
  vi.useFakeTimers();
  answer = refused;
  vi.stubGlobal('fetch', vi.fn(async () => answer()));
  localStorage.setItem('hh-lang', 'en');
  connection.reset();
});
afterEach(() => {
  connection.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const shown = () =>
  render(
    <LanguageProvider>
      <ConnectionLayer />
    </LanguageProvider>,
  );

async function missed(why: 'lost' | 'updating' = 'lost') {
  await act(async () => {
    connection.lost(why);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/* The sign, once, and the line, and nothing else inside the layer. */
function expectSignAndOneLine(container: HTMLElement, line: string) {
  const layer = screen.getByRole('alertdialog', { name: line });
  expect(layer.textContent).toBe(line);
  expect(layer.querySelectorAll('svg')).toHaveLength(1);
  expect(layer.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  expect(layer.querySelector('button, input, a, .spinner, h1, h3, h4, [role="status"]')).toBeNull();
  expect(container.querySelectorAll('button')).toHaveLength(0);
  expect(layer.textContent).not.toMatch(/[А-Яа-я]/);
}

describe('the layer over the page while the server is away', () => {
  it('shows nothing while the server answers', async () => {
    answer = up;
    const { container } = shown();
    await missed();
    expect(container.textContent).toBe('');
  });

  it('shows the sign and the one line "No connection" when the connection is lost', async () => {
    const { container } = shown();
    await missed();
    expectSignAndOneLine(container, 'No connection');
  });

  it('shows the sign and the one line "Updating" while an update installs, and keeps saying so through the restart', async () => {
    answer = maintenance;
    const { container } = shown();
    await missed('updating');
    expectSignAndOneLine(container, 'Updating');
    answer = refused;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expectSignAndOneLine(container, 'Updating');
  });

  it('says it in English whatever language the person chose, with no translation of the line', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const { container } = shown();
    await missed();
    expectSignAndOneLine(container, 'No connection');
    answer = maintenance;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expectSignAndOneLine(container, 'Updating');
  });

  it('adds nothing as the wait gets long: no second line, no counter, no ring', async () => {
    const { container } = shown();
    await missed();
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expectSignAndOneLine(container, 'No connection');
  });

  it('goes by itself once the server answers, with no click', async () => {
    const { container } = shown();
    await missed();
    expectSignAndOneLine(container, 'No connection');
    answer = up;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('takes the focus as the dialog it is, so a key goes nowhere under it, and Escape leaves it', async () => {
    const { container } = shown();
    await missed();
    const layer = screen.getByRole('alertdialog');
    expect(layer.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(layer);
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.contains(layer)).toBe(true);
  });
});

describe('what the layer looks like', () => {
  /* jsdom lays nothing out: the rules are read from the style book's stylesheet. */
  it('covers the page on a plain background of the theme, with the sign and the line centred, the sign in the inks of the theme', () => {
    expect(decl('.conn-layer', 'position')).toBe('fixed');
    expect(decl('.conn-layer', 'inset')).toBe('0');
    expect(decl('.conn-layer', 'background')).toBe('var(--bg)');
    expect(decl('.conn-layer', 'place-items')).toBe('center');
    expect(decl('.conn-layer', 'z-index')).toBe('60');
    expect(decl('.conn-mark', 'width')).toBe('48px');
    expect(decl('.mk-dome', 'stroke')).toBe('var(--cyan)');
    expect(decl('.mk-base', 'stroke')).toBe('var(--ink)');
    expect(decl('.conn-line', 'text-align')).toBe('center');
  });
});
