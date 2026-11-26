import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../src/connection';
import { LanguageProvider, loadMessages } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { SERVICE_LINES, service } from '../src/service-state';
import { MaterialViewer } from '../src/ui/MaterialViewer';
import { ServiceLayout, ServiceLoader, ServiceStrip, ServiceWindow, useServiceNotice } from '../src/ui/ServiceRoad';

/* The service road, drawn (#2098, #2099, Design #2100): window, then strip, then gone; the loader in a page area's own place.
   The look is Design's; these tests hold what it must keep: one message at a time, the window and the strip never together,
   nothing to press but the window's close, English words in every language, no number on the screen, and a way back to the
   page by itself. */

const road = () => render(<LanguageProvider><ServiceWindow /><ServiceStrip /></LanguageProvider>);

const lose = async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  await act(async () => {
    connection.lost('lost');
    await vi.advanceTimersByTimeAsync(0);
  });
};

const serverBack = async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"build":"b1"}', { status: 200 })));
  await act(async () => {
    connection.tryNow();
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  service.reset();
  connection.reset();
});

it('lets the service window take focus over a preview and hides the preview during an update', async () => {
  const { container } = render(<LanguageProvider><ServiceLayout>
    <MaterialViewer items={[{ id: 'a', name: 'Attachment.txt', kind: 'file', state: 'available' }]}
      activeId="a" opener={null} onSelect={() => {}} onClose={() => {}} />
  </ServiceLayout></LanguageProvider>);
  const preview = document.querySelector('.mv-back')!;
  expect(container).toHaveAttribute('inert');
  expect(preview).toBeVisible();

  await lose();
  const dialog = screen.getByRole('dialog', { name: SERVICE_LINES.lost });
  const close = within(dialog).getByRole('button', { name: 'Close' });
  expect(close.closest('[inert]')).toBeNull();
  expect(close).toHaveFocus();
  expect(preview).not.toBeVisible();
  fireEvent.click(close);
  expect(preview).toBeVisible();

  act(() => service.setUpdate(true));
  expect(preview).not.toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Updating…');
});

afterEach(() => {
  service.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the window and the strip', () => {
  it('draw nothing while nothing is wrong', () => {
    const { container } = road();
    expect(container).toBeEmptyDOMElement();
  });

  it('open as one window on the shared scrim, with the logo and one English line in every language, and the close as its only button', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const { container } = road();
    await lose();

    const dialog = screen.getByRole('dialog', { name: SERVICE_LINES.lost });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('.dialog-back')).not.toBeNull();
    expect(dialog).toHaveTextContent(SERVICE_LINES.lost);
    expect(dialog.querySelector('.svc-line')).toHaveAttribute('lang', 'en');
    expect(dialog.querySelector('svg .mk-dome')).not.toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBe(dialog.querySelector('.window-close'));
    expect(dialog.querySelectorAll('.spinner, .svc-ring, h1, h2, input, .svc-progress')).toHaveLength(0);
    expect(container.querySelector('[role="status"]')).toBeNull();
    /* Not a countdown, not a Retry, not "Try now". */
    expect(container.textContent).not.toMatch(/retry|try now|next try|\d/i);
  });

  it('give the focus to the close button, keep Tab on it, and give the focus back after', async () => {
    render(<LanguageProvider><button type="button">Page</button><ServiceWindow /></LanguageProvider>);
    screen.getByRole('button', { name: 'Page' }).focus();
    await lose();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    act(() => service.close());
    expect(screen.getByRole('button', { name: 'Page' })).toHaveFocus();
  });

  it.each([
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click outside it', () => fireEvent.pointerDown(document.querySelector('.dialog-back')!)],
  ])('go on as the strip once %s closed the window, with no window left', async (_how, close) => {
    road();
    await lose();
    act(() => { close(); });

    expect(screen.queryByRole('dialog')).toBeNull();
    const strip = screen.getByRole('status');
    expect(strip).toHaveClass('svc-strip', 'glass');
    expect(strip).toHaveAttribute('aria-live', 'polite');
    expect(strip).toHaveTextContent(SERVICE_LINES.lost);
    expect(strip.querySelector('svg .mk-dome')).not.toBeNull();
    /* It cannot be closed, and nothing in it asks for anything or takes the focus. */
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(strip.querySelectorAll('[tabindex], a, input')).toHaveLength(0);
  });

  it('keep the window open for a click inside it', async () => {
    road();
    await lose();
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('are never the window and the strip together, and go by themselves when the server answers', async () => {
    road();
    const both = () => screen.queryByRole('dialog') !== null && screen.queryByRole('status') !== null;
    await lose();
    expect(both()).toBe(false);
    act(() => service.close());
    expect(both()).toBe(false);
    expect(screen.getByRole('status')).toBeInTheDocument();
    await serverBack();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the shared loading screen for an update while the loaded page stays mounted', () => {
    render(<LanguageProvider><ServiceLayout><button type="button">Page</button></ServiceLayout></LanguageProvider>);
    act(() => service.setUpdate(true));
    const loader = screen.getByRole('status');
    expect(loader).toHaveTextContent('Updating…');
    expect(loader.querySelectorAll('.boot-dots > i')).toHaveLength(3);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Page' })).toBeNull();
    expect(screen.getByText('Page')).not.toBeVisible();
    act(() => service.setUpdate(false));
    expect(screen.getByRole('button', { name: 'Page' })).toBeVisible();
  });

  it('uses the English service line while the page language is Russian', async () => {
    const words = await loadMessages('ru');
    expect(words.boot.loading).toBe(ru.boot.loading);
    localStorage.setItem('hh-lang', 'ru');
    render(<LanguageProvider><ServiceLayout starting>{null}</ServiceLayout></LanguageProvider>);
    expect(document.documentElement).toHaveAttribute('lang', 'ru');
    expect(screen.getByRole('status')).toHaveTextContent(ru.common.loading);
    act(() => service.setUpdate(true));
    expect(screen.getByText('Updating…').closest('p')).toHaveAttribute('lang', 'en');
  });

  it('shows only the same boot loader when the connection drops before the app loads', async () => {
    render(<LanguageProvider><ServiceLayout starting>{null}</ServiceLayout></LanguageProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await lose();
    expect(screen.getByRole('status')).toHaveTextContent(SERVICE_LINES.lost);
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('say only the most important state: no internet over a lost server over a notice', async () => {
    road();
    act(() => service.notify('relay', 'A notice'));
    await lose();
    expect(screen.getByRole('dialog')).toHaveTextContent(SERVICE_LINES.lost);
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveTextContent(SERVICE_LINES.offline);
  });

  it('keeps a dismissed notice in the strip until it ends', () => {
    road();
    act(() => service.notify('page', 'A notice'));
    expect(screen.getByRole('dialog')).toHaveTextContent('A notice');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('A notice');
    act(() => service.clear('page'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('say a notice of the page in its own language, not marked as English', () => {
    road();
    act(() => service.notify('app', 'Hornhoof does not answer'));
    expect(screen.getByRole('dialog').querySelector('.svc-line')).not.toHaveAttribute('lang');
  });
});

describe('a notice a screen holds while its reason stands', () => {
  function Holds({ on }: { on: boolean }) {
    useServiceNotice('held', on, 'Something is wrong here');
    return null;
  }

  it('is said while the reason stands, and goes with the reason and with the screen', () => {
    const { rerender, unmount } = render(<LanguageProvider><ServiceWindow /><Holds on={false} /></LanguageProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<LanguageProvider><ServiceWindow /><Holds on /></LanguageProvider>);
    expect(screen.getByRole('dialog', { name: 'Something is wrong here' })).toBeInTheDocument();
    rerender(<LanguageProvider><ServiceWindow /><Holds on={false} /></LanguageProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<LanguageProvider><ServiceWindow /><Holds on /></LanguageProvider>);
    expect(service.snapshot()?.message.line).toBe('Something is wrong here');
    unmount();
    expect(service.snapshot()).toBeNull();
  });
});

describe('the loader of a page area with nothing cached', () => {
  it('draws nothing while no state stands', () => {
    const { container } = render(<LanguageProvider><ServiceLoader /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the logo, the dots and the same line in place, with no window of its own and nothing to press', async () => {
    const { container } = render(<LanguageProvider><ServiceLoader /></LanguageProvider>);
    await lose();
    act(() => service.close());
    const loader = screen.getByRole('status');
    expect(loader).not.toHaveAttribute('aria-busy', 'true');
    expect(loader).toHaveAttribute('aria-live', 'polite');
    expect(loader).toHaveTextContent(SERVICE_LINES.lost);
    expect(loader.querySelector('svg .mk-dome')).not.toBeNull();
    expect(loader.querySelectorAll('.boot-dots > i')).toHaveLength(3);
    expect(container.querySelectorAll('button, [role="dialog"]')).toHaveLength(0);
    await serverBack();
    expect(container).toBeEmptyDOMElement();
  });

  it('draws no second outage line behind the service window on an uncached page', async () => {
    const { container } = render(<LanguageProvider><ServiceLayout><ServiceLoader /></ServiceLayout></LanguageProvider>);
    await lose();
    expect(screen.getByRole('dialog', { name: SERVICE_LINES.lost })).toBeVisible();
    expect(container.querySelector('.svc-loader')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('status')).toHaveTextContent(SERVICE_LINES.lost);
    expect(container.querySelector('.svc-loader')).not.toBeNull();
  });

  it('keeps the strip off its screen, since the line is said there, and brings it back with the loader gone', async () => {
    const { rerender } = render(<LanguageProvider><ServiceStrip /><ServiceLoader /></LanguageProvider>);
    await lose();
    act(() => service.close());
    /* One status on the screen: the loader's. */
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(document.querySelector('.svc-strip')).toBeNull();
    expect(document.querySelector('.svc-loader')).not.toBeNull();
    rerender(<LanguageProvider><ServiceStrip /></LanguageProvider>);
    expect(document.querySelector('.svc-strip')).not.toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('takes no role of its own where a second area of the screen shows it too', async () => {
    render(<LanguageProvider><ServiceLoader /><ServiceLoader live={false} /></LanguageProvider>);
    await lose();
    act(() => service.close());
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(document.querySelectorAll('.svc-loader')).toHaveLength(2);
  });
});
