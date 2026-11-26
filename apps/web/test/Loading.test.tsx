import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../src/api';
import { connection } from '../src/connection';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { service } from '../src/service-state';
import { decl } from './css';
import { Hold, Idle, LoadState, MAX_HELD_ROWS, RING_DELAY_MS, RING_MIN_MS, STUCK_MS, useHeldRows, useLoad, type LoadPart } from '../src/ui/Loading';

/* One load of a screen from its parts, on the style book's timeline (1.5, section 4, #2099): no ring for the first 400 ms,
   then the ring at least 500 ms; a wait of any length says nothing of itself, and a load with no answer for 30 s is asked
   again by itself; an error answer with a reason fails at once, and the server being away is no failure. Retry asks again
   for what is missing, with the ring at once. The clock goes only as far as a test moves it. */
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('hh-lang', 'en');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Shown({ parts }: { parts: LoadPart[] }) {
  const load = useLoad(parts);
  return <LanguageProvider><LoadState load={load} /><i className="phase">{load.phase}</i></LanguageProvider>;
}

/* A page area with nothing cached: where a state of the service road says itself in place. */
function ShownScreen({ parts }: { parts: LoadPart[] }) {
  const load = useLoad(parts);
  return <LanguageProvider><LoadState load={load} form="screen" /><i className="phase">{load.phase}</i></LanguageProvider>;
}

/* A held list: its skeleton while the data comes, the rows once the load is done. */
function Held({ parts }: { parts: LoadPart[] }) {
  const load = useLoad(parts);
  return (
    <LanguageProvider>
      <Hold load={load} className="rows">
        {load.phase === 'done' ? <ul><li>a row</li></ul> : <ul><li><Idle w="60%" /></li></ul>}
      </Hold>
    </LanguageProvider>
  );
}

const part = (data: unknown, failure: unknown = null, load = vi.fn(), cancel = vi.fn()): LoadPart => ({ data, failure, load, cancel });
const later = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const phase = (c: HTMLElement) => c.querySelector('.phase')?.textContent;
const ringShown = (c: HTMLElement) => c.querySelector('.load-busy:not(.unseen) > .spinner') !== null;

describe('the ring of one load', () => {
  it('holds the room unseen for the first 400 ms, then shows the ring with its words as the screen status', () => {
    const { container } = render(<Shown parts={[part(undefined)]} />);
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    expect(ringShown(container)).toBe(false);
    later(RING_DELAY_MS - 1);
    expect(ringShown(container)).toBe(false);
    later(1);
    expect(ringShown(container)).toBe(true);
    expect(container.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('never shows a ring for data that comes before 400 ms', () => {
    const { rerender, container } = render(<Shown parts={[part(undefined)]} />);
    later(RING_DELAY_MS - 50);
    rerender(<Shown parts={[part([1])]} />);
    expect(phase(container)).toBe('done');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the ring at least 500 ms once it showed, holding data that came sooner', () => {
    const { rerender, container } = render(<Shown parts={[part(undefined)]} />);
    later(RING_DELAY_MS + 50);
    rerender(<Shown parts={[part([1])]} />);
    expect(phase(container)).toBe('loading');
    expect(ringShown(container)).toBe(true);
    later(RING_MIN_MS - 51);
    expect(phase(container)).toBe('loading');
    later(1);
    expect(phase(container)).toBe('done');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the wait of one load', () => {
  it('says nothing of a long wait: no card, no Retry, no words, the ring keeps turning', () => {
    const { container } = render(<Shown parts={[part(undefined), part(undefined)]} />);
    later(RING_DELAY_MS);
    later(STUCK_MS * 2 - RING_DELAY_MS - 1);
    expect(phase(container)).toBe('loading');
    expect(container.querySelector('.load-fail')).toBeNull();
    expect(container.textContent).not.toContain(en.common.tooLong);
    expect(screen.queryByRole('button', { name: en.common.retry })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.load-hold')?.getAttribute('aria-busy')).toBe('true');
    expect(ringShown(container)).toBe(true);
  });

  it('asks what is missing again at 30 s, and every 30 s after, cancelling the ask still running, and has the page look at the server', () => {
    const looked = vi.spyOn(connection, 'lost').mockImplementation(() => {});
    const missing = part(undefined);
    const came = part([1]);
    render(<Shown parts={[came, missing]} />);
    later(STUCK_MS - 1);
    expect(missing.load).not.toHaveBeenCalled();
    later(1);
    expect(missing.cancel).toHaveBeenCalledTimes(1);
    expect(missing.load).toHaveBeenCalledTimes(1);
    expect(looked).toHaveBeenCalledTimes(1);
    expect(came.cancel).not.toHaveBeenCalled();
    expect(came.load).not.toHaveBeenCalled();
    later(STUCK_MS);
    expect(missing.load).toHaveBeenCalledTimes(2);
  });

  it('is one limit for the whole load, not one per part', () => {
    const lazy = part(undefined);
    const { rerender } = render(<Shown parts={[part(undefined), lazy]} />);
    later(STUCK_MS - 5_000);
    rerender(<Shown parts={[part([1]), lazy]} />);
    later(5_000);
    expect(lazy.load).toHaveBeenCalledTimes(1);
  });

  it('asks again on Retry for only what is missing, cancelling the ask still running, with the ring at once', () => {
    const came = part([1]);
    const missing = part(undefined, new ApiFailure(403, 'forbidden', 'No access.'));
    const { container } = render(<Shown parts={[came, missing]} />);
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(missing.cancel).toHaveBeenCalledTimes(1);
    expect(missing.load).toHaveBeenCalledTimes(1);
    expect(came.load).not.toHaveBeenCalled();
    expect(ringShown(container)).toBe(true);
    expect(phase(container)).toBe('loading');
  });

  it('waits for a part that failed because the server is away, with nothing to say, and asks it again by itself after a growing wait', () => {
    const away = () => new ApiFailure(0, 'network', '');
    const missing = part(undefined, away());
    const { rerender, container } = render(<Shown parts={[missing]} />);
    expect(phase(container)).toBe('loading');
    expect(screen.queryByRole('alert')).toBeNull();
    later(999);
    expect(missing.load).not.toHaveBeenCalled();
    later(1);
    expect(missing.load).toHaveBeenCalledTimes(1);
    /* It failed again: the next ask comes after 2 s, then 4. Not once did the person see a card or a button. */
    rerender(<Shown parts={[{ ...missing, failure: away() }]} />);
    later(1_999);
    expect(missing.load).toHaveBeenCalledTimes(1);
    later(1);
    expect(missing.load).toHaveBeenCalledTimes(2);
    rerender(<Shown parts={[{ ...missing, failure: new ApiFailure(502, 'unavailable', 'Starting.', 'starting') }]} />);
    later(4_000);
    expect(missing.load).toHaveBeenCalledTimes(3);
    expect(container.querySelector('.load-fail')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    /* It came: the waits start over. */
    rerender(<Shown parts={[{ ...missing, data: [1], failure: null }]} />);
    later(RING_MIN_MS);
    expect(phase(container)).toBe('done');
  });

  it('does not ask on a timer a part an update refused: it waits for the connection to come back, once the page has seen which build runs', () => {
    const missing = part(undefined, new ApiFailure(503, 'unavailable', 'Updating.', 'maintenance'));
    const { container } = render(<Shown parts={[missing]} />);
    later(60_000);
    expect(missing.load).not.toHaveBeenCalled();
    expect(phase(container)).toBe('loading');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a state of the service road in place of the ring of a page area while one stands: the logo and the same line, nothing to press', () => {
    const { container } = render(<ShownScreen parts={[part(undefined)]} />);
    later(RING_DELAY_MS);
    expect(container.querySelector('.load-boot')).not.toBeNull();
    act(() => service.notify('x', 'A state'));
    act(() => service.close());
    expect(container.querySelector('.load-boot')).toBeNull();
    const loader = container.querySelector('.svc-loader')!;
    expect(loader.textContent).toBe('A state');
    expect(loader.querySelector('svg .mk-dome')).not.toBeNull();
    expect(loader.querySelectorAll('button')).toHaveLength(0);
    act(() => service.clear('x'));
    expect(container.querySelector('.svc-loader')).toBeNull();
    expect(container.querySelector('.load-boot')).not.toBeNull();
  });

  it('keeps its own ring and words for a small part of a card while a state of the service road stands', () => {
    const { container } = render(<Shown parts={[part(undefined)]} />);
    later(RING_DELAY_MS);
    act(() => service.notify('x', 'A state'));
    expect(container.querySelector('.load-busy')).not.toBeNull();
    expect(container.querySelector('.svc-loader')).toBeNull();
  });
});

describe('why a load failed', () => {
  const said = (failure: unknown) => {
    render(<Shown parts={[part(undefined, failure)]} />);
    const block = screen.getByRole('alert');
    return [block.querySelector('.lf-t')?.textContent, block.querySelector('.lf-h')?.textContent];
  };

  it('says an error answer at once, as one whole sentence with its own hint', () => {
    expect(said(new ApiFailure(500, 'internal', 'boom'))).toEqual([en.load.failed.server, en.load.hint.server]);
  });

  it("says an answer's own reason where the server names one", () => {
    expect(said(new ApiFailure(403, 'forbidden', 'You do not have access to this.'))).toEqual(['You do not have access to this.', en.load.hint.server]);
  });

  it('after Retry counts only a new failure while the part is asked again, and says nothing of a part that failed after it came', () => {
    const first = new Error('first');
    const failed = part(undefined, first);
    const { rerender, container } = render(<Shown parts={[failed]} />);
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(failed.load).toHaveBeenCalledTimes(1);
    rerender(<Shown parts={[{ ...failed }]} />);
    expect(phase(container)).toBe('loading');
    rerender(<Shown parts={[{ ...failed, failure: new Error('second') }]} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Shown parts={[{ ...failed, data: [], failure: new Error('a later read failed') }]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    later(RING_MIN_MS);
    expect(phase(container)).toBe('done');
  });
});

describe('the held room', () => {
  it('keeps its skeleton unseen under the failure, and takes the focus after Retry', () => {
    const { container } = render(<Held parts={[part(undefined, new ApiFailure(500, 'internal', ''))]} />);
    const room = container.querySelector('.load-hold') as HTMLElement;
    expect(room.querySelector('.load-gone')?.getAttribute('aria-hidden')).toBe('true');
    expect(room.querySelector('.load-gone .ph')).not.toBeNull();
    expect(room.getAttribute('aria-busy')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(document.activeElement).toBe(room);
  });

  it('fades the data in once it came after a wait, and shows data there from the start at once', () => {
    const { rerender, container } = render(<Held parts={[part(undefined)]} />);
    expect(container.querySelector('.load-hold')?.getAttribute('aria-busy')).toBe('true');
    rerender(<Held parts={[part([1])]} />);
    expect(container.querySelector('.load-in')?.classList.contains('arrive')).toBe(true);
    expect(container.querySelector('.load-hold')?.getAttribute('aria-busy')).toBe('false');
    const again = render(<Held parts={[part([1])]} />);
    expect(again.container.querySelector('.load-in')?.classList.contains('arrive')).toBe(false);
  });
});

describe('a part another part of the screen says', () => {
  it('is only awaited: its failure is not said again, and no limit counts while it is missing', () => {
    const quiet = { ...part(undefined, new ApiFailure(500, 'internal', '')), quiet: true };
    const { container } = render(<Shown parts={[part([1]), quiet]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    later(STUCK_MS * 2);
    expect(phase(container)).toBe('loading');
    expect(quiet.load).not.toHaveBeenCalled();
  });
});

/* Design #1611: a list holds as many rows as it showed last in this tab, at most 40; with none kept, or a tab that keeps
   nothing, it fills what is in view. */
describe('the rows a list holds while it loads', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('knows none at first, then the count the list showed last, kept per list', () => {
    const { result, rerender } = renderHook(({ list, shown }) => useHeldRows(list, shown), { initialProps: { list: 'mine|list', shown: null as number | null } });
    expect(result.current).toBeNull();
    rerender({ list: 'mine|list', shown: 7 });
    rerender({ list: 'mine|list', shown: null });
    expect(result.current).toBe(7);
    rerender({ list: 'company|list', shown: null });
    expect(result.current).toBeNull();
  });

  it('holds at most 40, and at least one row of a list that showed none', () => {
    const { result, rerender } = renderHook(({ shown }) => useHeldRows('long', shown), { initialProps: { shown: 500 as number | null } });
    rerender({ shown: null });
    expect(result.current).toBe(MAX_HELD_ROWS);
    rerender({ shown: 0 });
    rerender({ shown: null });
    expect(result.current).toBe(1);
  });

  it('fills what is in view where the tab keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result, rerender } = renderHook(({ shown }) => useHeldRows('private', shown), { initialProps: { shown: 5 as number | null } });
    rerender({ shown: null });
    expect(result.current).toBeNull();
  });
});

describe('the look of a failed load', () => {
  afterEach(() => localStorage.clear());

  /* Style book 1.5, section 4, rule 6: in a window set in monospace, "секунд." wrapped onto a line of its own. */
  it('is in the body font everywhere, whatever font the window around it has', () => {
    expect(decl('.load-fail', 'font-family')).toBe('var(--f-body)');
  });

  /* Design #1654: on a phone «Повторить» broke into «По-» and «вторить». */
  it.each([
    ['en', en.load.hint.server, '"Retry"'],
    ['ru', ru.load.hint.server, '«Повторить»'],
  ])('keeps the quoted name of its button whole on one line, with its quotes, in %s', (language, hint, quoted) => {
    localStorage.setItem('hh-lang', language);
    const { container } = render(<Shown parts={[part(undefined, new ApiFailure(500, 'internal', ''))]} />);
    const words = container.querySelector('.load-fail .lf-h')!;
    expect(words.textContent).toBe(hint);
    expect([...words.querySelectorAll('.lf-name')].map(name => name.textContent)).toEqual([quoted]);
    expect(decl('.load-fail .lf-name', 'white-space')).toBe('nowrap');
  });

  it('leaves words that quote no button as they are', () => {
    const { container } = render(<Shown parts={[part(undefined, new ApiFailure(403, 'forbidden', 'You do not have access to this.'))]} />);
    expect(container.querySelector('.lf-t')!.textContent).toBe('You do not have access to this.');
    expect(container.querySelector('.lf-t .lf-name')).toBeNull();
  });

  /* #1621: on a page laid out right to left, the period of a sentence in a language read left to right stood at its start. */
  it('lets its words take the direction of their own language', () => {
    const { container } = render(<Shown parts={[part(undefined, new ApiFailure(500, 'internal', ''))]} />);
    expect([...container.querySelectorAll('.load-fail > p')].map(p => p.getAttribute('dir'))).toEqual(['auto', 'auto']);
  });
});
