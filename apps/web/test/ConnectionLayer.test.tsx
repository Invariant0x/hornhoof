import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../src/connection';
import { LanguageProvider } from '../src/i18n';
import { ConnectionLayer } from '../src/ui/ConnectionLayer';

const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } };

describe('ConnectionLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connection.reset();
  });

  afterEach(() => {
    connection.reset();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('renders nothing while the server answers', () => {
    const { container } = render(<LanguageProvider><ConnectionLayer /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['lost', 'No connection', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['updating', 'Updating', () => Promise.resolve(new Response(JSON.stringify(MAINTENANCE), { status: 503 }))],
  ] as const)('shows only the Hornhoof logo and "%s" -> "%s" in English, even in Russian and after a long wait', async (why, expected, reply) => {
    localStorage.setItem('hh-lang', 'ru');
    let holdLook = false;
    vi.stubGlobal('fetch', vi.fn(() => (holdLook ? new Promise<Response>(() => {}) : reply())));

    const { container } = render(<LanguageProvider><ConnectionLayer /></LanguageProvider>);
    await act(async () => {
      connection.lost(why);
      await vi.advanceTimersByTimeAsync(0);
    });

    const dialog = screen.getByRole('alertdialog', { name: expected });
    expect(dialog).toHaveTextContent(expected);
    expect(dialog.textContent).toBe(expected);
    expect(dialog.querySelectorAll('svg')).toHaveLength(1);
    expect(dialog.querySelector('svg .mk-dome')).not.toBeNull();
    expect(dialog.querySelector('svg .mk-base')).not.toBeNull();
    expect(dialog.querySelector('svg .mk-dot')).not.toBeNull();
    expect(dialog.querySelectorAll('button, .spinner, h1, h2')).toHaveLength(0);

    /* Even after 6 minutes and during an in-flight retry, nothing else appears. */
    holdLook = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360_000);
    });
    expect(dialog.textContent).toBe(expected);
    expect(container.querySelectorAll('button, .spinner')).toHaveLength(0);

    /* Returns by itself once the server answers. */
    holdLook = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"build":"b1"}', { status: 200 })));
    await act(async () => {
      connection.tryNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
