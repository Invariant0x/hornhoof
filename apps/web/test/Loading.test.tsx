import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../src/api';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { UpdateSaysIt } from '../src/ui/LoadFailure';
import { FAIL_MS, Hold, Idle, LoadState, RING_DELAY_MS, RING_MIN_MS, SLOW_MS, useLoad, type LoadPart } from '../src/ui/Loading';

/* One load of a screen from its parts, on the style book's timeline (1.5, section 4): no ring for the first 400 ms, then the
   ring at least 500 ms; at 10 s it takes longer than usual, at 30 s it is given up; an error answer fails at once. Retry asks
   again for what is missing, with the ring at once. The clock goes only as far as a test moves it. */
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('hh-lang', 'en');
});
afterEach(() => vi.useRealTimers());

function Shown({ parts }: { parts: LoadPart[] }) {
  const load = useLoad(parts);
  return <LanguageProvider><LoadState load={load} /><i className="phase">{load.phase}</i></LanguageProvider>;
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

describe('the limits of one load', () => {
  it('says at 10 s that it takes longer than usual, with the ring still turning and Retry, as the ask still runs', () => {
    const { container } = render(<Shown parts={[part(undefined), part(undefined)]} />);
    later(SLOW_MS - 1);
    expect(phase(container)).toBe('loading');
    later(1);
    const slow = container.querySelector('.load-fail.slow')!;
    expect(slow.getAttribute('role')).toBe('status');
    expect(slow.querySelector('.lf-t')?.textContent).toBe(en.common.tooLong);
    expect(slow.querySelector('.lf-t .spinner')).not.toBeNull();
    expect(slow.querySelector('.lf-h')?.textContent).toBe(en.load.slowHint);
    expect(screen.getByRole('button', { name: en.common.retry })).toBeTruthy();
    expect(container.querySelector('.load-hold')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is one limit for the whole load, not one per part', () => {
    const { rerender, container } = render(<Shown parts={[part(undefined), part(undefined)]} />);
    later(SLOW_MS - 5_000);
    rerender(<Shown parts={[part([1]), part(undefined)]} />);
    later(5_000);
    expect(phase(container)).toBe('slow');
  });

  it('gives the load up at 30 s: cancels the asks still running and says the server did not answer, with Retry', () => {
    const missing = part(undefined);
    const came = part([1]);
    const { container } = render(<Shown parts={[came, missing]} />);
    later(FAIL_MS);
    const failed = screen.getByRole('alert');
    expect(failed.querySelector('.lf-t')?.textContent).toBe(en.load.failed.timeout);
    expect(failed.querySelector('.lf-h')?.textContent).toBe(en.load.hint.timeout);
    expect(missing.cancel).toHaveBeenCalledTimes(1);
    expect(came.cancel).not.toHaveBeenCalled();
    expect(container.querySelector('.load-fail .spinner')).toBeNull();
    expect(container.querySelector('.load-gone')).not.toBeNull();
    expect(container.querySelector('.load-hold')?.getAttribute('aria-busy')).toBe('false');
  });

  it('asks again on Retry for only what is missing, cancelling the ask still running, with the ring at once and the limits over', () => {
    const came = part([1]);
    const missing = part(undefined);
    const { container } = render(<Shown parts={[came, missing]} />);
    later(SLOW_MS);
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(missing.cancel).toHaveBeenCalledTimes(1);
    expect(missing.load).toHaveBeenCalledTimes(1);
    expect(came.load).not.toHaveBeenCalled();
    expect(ringShown(container)).toBe(true);
    later(SLOW_MS - 1);
    expect(phase(container)).toBe('loading');
    later(1);
    expect(phase(container)).toBe('slow');
  });

  it('waits with no limit for a part the update holds back while the update panel says it, and fails when the panel does not', () => {
    const refused = new ApiFailure(503, 'unavailable', 'Hornhoof is installing an update.', 'maintenance');
    const { rerender, container } = render(<UpdateSaysIt.Provider value={true}><Shown parts={[part(undefined, refused)]} /></UpdateSaysIt.Provider>);
    later(FAIL_MS * 3);
    expect(phase(container)).toBe('loading');
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<UpdateSaysIt.Provider value={false}><Shown parts={[part(undefined, refused)]} /></UpdateSaysIt.Provider>);
    expect(screen.getByRole('alert')).toBeTruthy();
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

  it('says there is no connection when the server cannot be reached', () => {
    expect(said(new ApiFailure(0, 'network', ''))).toEqual([en.load.failed.offline, en.load.hint.offline]);
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
    later(FAIL_MS * 2);
    expect(phase(container)).toBe('loading');
  });
});
