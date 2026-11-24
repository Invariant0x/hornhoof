import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { everyVisible, guardedResizeObserver, isLight, leaveLight, rateMeter, useRenderGuard, watchFrames } from '../src/guard';
import { listen, useStream } from '../src/live';
import { LanguageProvider } from '../src/i18n';
import { GuardBoundary, LightNotice } from '../src/ui/GuardBoundary';
import { decl, rulesFor } from './css';
import { fakeStream } from './fake-stream';

/* Everything here runs on the test's clock: no check waits for real time to pass. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  act(() => leaveLight());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* Hides the tab or shows it again, as the browser tells the page. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('the rate meter', () => {
  it('trips only past its limit within its window, on the clock it is given', () => {
    let now = 0;
    const meter = rateMeter(3, 1000, () => now);
    expect([meter.hit(), meter.hit(), meter.hit()]).toEqual([false, false, false]);
    expect(meter.hit()).toBe(true);
    now = 1001;
    expect(meter.hit()).toBe(false);
  });
});

/* A block that sets its state after every drawing while `loops` says so: the endless loop that kept a tab at full CPU. */
const loop = { on: true };
function Spinning() {
  useRenderGuard('spinning');
  const [n, setN] = useState(0);
  useEffect(() => {
    if (loop.on) setN(n + 1);
  });
  return <p>Drawn {n > 0 ? 'again' : 'once'}</p>;
}

describe('a block that redraws without end', () => {
  it('is stopped behind its boundary, the page goes light, and the block restarts softly at a button', () => {
    loop.on = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <>
        <GuardBoundary block="spinning">
          <Spinning />
        </GuardBoundary>
        <p>The rest of the page</p>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This block was stopped: it was slowing the screen down.');
    expect(screen.getByText('The rest of the page')).toBeInTheDocument();
    expect(isLight()).toBe(true);
    expect(document.documentElement.dataset.light).toBe('on');
    loop.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Restart block' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Drawn/)).toBeInTheDocument();
  });

  it('lets a block that redraws often but stops, as typing does, keep drawing', () => {
    function Typing() {
      useRenderGuard('typing');
      const [text, setText] = useState('');
      return <input aria-label="Words" value={text} onChange={e => setText(e.target.value)} />;
    }
    render(
      <GuardBoundary block="typing">
        <Typing />
      </GuardBoundary>,
    );
    const input = screen.getByRole('textbox', { name: 'Words' });
    for (let i = 0; i < 120; i++) fireEvent.change(input, { target: { value: 'x'.repeat(i + 1) } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(isLight()).toBe(false);
  });

  it('shows what went wrong in a block that failed some other way, and leaves the effects on', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('no');
    }
    render(
      <GuardBoundary block="broken">
        <Broken />
      </GuardBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This block was stopped: something went wrong in it.');
    expect(isLight()).toBe(false);
  });
});

describe('the light mode', () => {
  it('says why the effects are off and turns them back on at a button', () => {
    vi.stubGlobal('ResizeObserver', HandObserver);
    render(<LightNotice />);
    expect(screen.queryByRole('status')).toBeNull();
    const observer = guardedResizeObserver(() => {}, 'panel');
    act(() => {
      for (let i = 0; i < 40; i++) HandObserver.last!.size(i % 2 ? 300 : 320);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Effects are off to keep the screen responsive.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn effects back on' }));
    expect(isLight()).toBe(false);
    expect(document.documentElement.dataset.light).toBeUndefined();
    expect(screen.queryByRole('status')).toBeNull();
    observer.disconnect();
  });
});

/* A ResizeObserver the test drives by hand: what the guarded one hands to the block it watches for. */
class HandObserver {
  static last: HandObserver | null = null;
  disconnected = false;
  constructor(readonly cb: ResizeObserverCallback) {
    HandObserver.last = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  size(width: number) {
    this.cb([{ contentRect: { width, height: 90 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe('a ResizeObserver that swings between two sizes', () => {
  it('is held back to its newest size after a pause, and the page goes light', () => {
    vi.stubGlobal('ResizeObserver', HandObserver);
    const seen: number[] = [];
    const observer = guardedResizeObserver(entries => seen.push(entries[0]!.contentRect.width), 'panel');
    for (let i = 0; i < 200; i++) HandObserver.last!.size(i % 2 ? 300 : 320);
    expect(seen.length).toBeLessThan(20);
    expect(isLight()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(seen.at(-1)).toBe(300);
    observer.disconnect();
    expect(HandObserver.last!.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes every size of a box that grows step by step, as a dragged edge makes it', () => {
    vi.stubGlobal('ResizeObserver', HandObserver);
    const seen: number[] = [];
    const observer = guardedResizeObserver(entries => seen.push(entries[0]!.contentRect.width), 'panel');
    for (let i = 0; i < 100; i++) HandObserver.last!.size(300 + i);
    expect(seen).toHaveLength(100);
    expect(isLight()).toBe(false);
    observer.disconnect();
  });

  it('leaves no timer behind once it is disconnected in the middle of its pause', () => {
    vi.stubGlobal('ResizeObserver', HandObserver);
    const seen: number[] = [];
    const observer = guardedResizeObserver(entries => seen.push(entries[0]!.contentRect.width), 'panel');
    for (let i = 0; i < 200; i++) HandObserver.last!.size(i % 2 ? 300 : 320);
    const before = seen.length;
    observer.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(before);
  });
});

describe('a storm of the stream', () => {
  it('reaches the screen in a few drawings, with the newest of it, instead of one drawing a message', () => {
    const stream = fakeStream();
    const drawn = { n: 0 };
    function Working() {
      const [working, setWorking] = useState(0);
      useStream(m => m.type === 'working' && setWorking(m.working));
      drawn.n++;
      return <p>Working {working}</p>;
    }
    render(<Working />);
    const before = drawn.n;
    for (let i = 1; i <= 300; i++) stream.send({ type: 'working', working: i });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Working 300')).toBeInTheDocument();
    expect(drawn.n - before).toBeLessThan(80);
  });

  it('hands every message on in its order while it is no storm', () => {
    const stream = fakeStream();
    const heard: number[] = [];
    const stop = listen(m => m.type === 'working' && heard.push(m.working));
    for (let i = 1; i <= 5; i++) stream.send({ type: 'working', working: i });
    expect(heard).toEqual([1, 2, 3, 4, 5]);
    stop();
  });

  it('becomes one "reconnected" when more piles up than the page should hold, and leaves no timer once nobody listens', () => {
    const stream = fakeStream();
    const heard: string[] = [];
    const stop = listen(m => heard.push(m.type));
    for (let i = 1; i <= 3000; i++) stream.send({ type: 'working', working: i });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(heard).toContain('reconnected');
    expect(heard.length).toBeLessThan(1500);
    for (let i = 1; i <= 300; i++) stream.send({ type: 'working', working: i });
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a poll that runs only while the tab is seen', () => {
  it('stops while the tab is hidden, catches up once when it is back, and leaves nothing once stopped', () => {
    setHidden(false);
    const poll = vi.fn();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const stop = everyVisible(poll, 1000);
    vi.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(3);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    setHidden(false);
    expect(poll).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1000);
    expect(poll).toHaveBeenCalledTimes(5);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls.map(c => c[1])).toEqual(add.mock.calls.filter(c => c[0] === 'visibilitychange').map(c => c[1]));
    setHidden(false);
    expect(poll).toHaveBeenCalledTimes(5);
  });
});

describe('the frame budget', () => {
  it('turns the page light after frames come late three times running, and only while the tab is seen', () => {
    setHidden(false);
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    const stop = watchFrames({ every: 2000, budget: 250, strikes: 3, now: () => now, frame: cb => frames.push(cb) });
    const lateFrames = (gap: number) => {
      vi.advanceTimersByTime(2000);
      frames.shift()!(now);
      now += gap;
      frames.shift()!(now);
    };
    lateFrames(400);
    lateFrames(400);
    lateFrames(16);
    lateFrames(400);
    lateFrames(400);
    expect(isLight()).toBe(false);
    lateFrames(400);
    expect(isLight()).toBe(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks for no frame while the tab is hidden, and watches again once it is back', () => {
    setHidden(true);
    const frames: FrameRequestCallback[] = [];
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const stop = watchFrames({ every: 2000, budget: 250, strikes: 3, now: () => 0, frame: cb => frames.push(cb) });
    vi.advanceTimersByTime(10_000);
    expect(frames).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    setHidden(false);
    vi.advanceTimersByTime(2000);
    expect(frames).toHaveLength(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    const watched = add.mock.calls.filter(c => c[0] === 'visibilitychange').map(c => c[1]);
    expect(remove.mock.calls.filter(c => c[0] === 'visibilitychange').map(c => c[1])).toEqual(expect.arrayContaining(watched));
  });
});

/* The two plates of the guard: one line and one button each, on the theme's tokens. */
describe('the plates of the guard', () => {
  it('say in Russian that the block stopped and that the effects are off, each with its role and its button', () => {
    localStorage.setItem('hh-lang', 'ru');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loop.on = true;
    render(
      <LanguageProvider>
        <GuardBoundary block="spinning">
          <Spinning />
        </GuardBoundary>
        <LightNotice />
      </LanguageProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/^Этот блок остановлен: он мешал работе экрана\.Перезапустить блок$/);
    expect(screen.getByRole('status')).toHaveTextContent(/^Эффекты выключены, чтобы экран не тормозил\.Вернуть эффекты$/);
    /* Restarting the block is the main choice, turning the effects back on the second. */
    expect(screen.getByRole('button', { name: 'Перезапустить блок' })).not.toHaveClass('ghost');
    expect(screen.getByRole('button', { name: 'Вернуть эффекты' })).toHaveClass('btn', 'ghost');
    loop.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Перезапустить блок' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть эффекты' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('say in Russian that a block which failed some other way stopped', () => {
    localStorage.setItem('hh-lang', 'ru');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('no');
    }
    render(
      <LanguageProvider>
        <GuardBoundary block="broken">
          <Broken />
        </GuardBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/^Этот блок остановлен: в нем произошла ошибка\.Перезапустить блок$/);
  });

  it('stand on the second surface in the strong line colour, the stopped one with a pink stripe at its start, with buttons of 44 px', () => {
    for (const plate of ['.guard-stop', '.light-note']) {
      /* The second surface at 99%, never fully opaque: Chromium drawing WebGL in software leaves a hole in the world
         map under one opaque plate (#1978, 95b53c554). */
      expect(decl(plate, 'background'), plate).toBe('color-mix(in srgb, var(--surface2) 99%, transparent)');
      expect(decl(plate, 'border'), plate).toBe('1px solid var(--line2)');
      expect(decl(`${plate} .btn`, 'min-block-size'), plate).toBe('44px');
    }
    expect(decl('.guard-stop', 'border-inline-start')).toBe('3px solid var(--pink-ink)');
    /* Turning the effects back on is the second choice: a ghost button, framed by a border rather than the
       ghost's shadow, which the light mode it stands in takes away. */
    expect(decl('.light-note .btn.ghost', 'border')).toBe('1px solid var(--line2)');
    expect(decl('.light-note .btn.ghost', 'box-shadow')).toBe('none');
    expect(decl('.light-note .btn.ghost:hover', 'border-color')).toBe('var(--cyan)');
    /* Logical sides only, so a right-to-left page mirrors them. */
    const physical = /^(left|right|top|bottom|margin-(left|right|top|bottom)|padding-(left|right|top|bottom)|border-(left|right))$/;
    for (const selector of ['.guard-stop', '.guard-stop.float', '.light-note', '.guard-stop .btn', '.light-note .btn', '.guard-stop p', '.light-note p']) {
      for (const rule of rulesFor(selector)) expect(Object.keys(rule.decls).filter(name => physical.test(name)), selector).toEqual([]);
    }
  });
});

