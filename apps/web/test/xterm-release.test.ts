import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeTerminal } from '../src/ui/xterm-release';

/* The real xterm, opened and closed in the page: what it leaves on the window and on the screen's media query. */
function counting() {
  const live = { resize: 0, media: 0 };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'resize') live.resize++;
    add(type, fn, options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === 'resize') live.resize--;
    remove(type, fn, options);
  });
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addListener: () => live.media++,
    removeListener: () => live.media--,
    addEventListener: () => live.media++,
    removeEventListener: () => live.media--,
  }));
  return live;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('a terminal that closes', () => {
  it('takes its listeners on the window and on the screen with it, so nothing keeps the closed terminal alive', () => {
    const live = counting();
    for (let i = 0; i < 3; i++) {
      const box = document.createElement('div');
      document.body.append(box);
      const term = new Terminal();
      term.open(box);
      expect(live.resize).toBeGreaterThan(0);
      disposeTerminal(term);
    }
    expect(live).toEqual({ resize: 0, media: 0 });
  });

  it('closes a terminal that never opened in a box', () => {
    const live = counting();
    disposeTerminal(new Terminal());
    expect(live).toEqual({ resize: 0, media: 0 });
  });
});
