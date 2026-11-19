import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { LOAD_LIMIT_MS, LoadState, useLoad, type LoadPart } from '../src/ui/Loading';

/* One load of a screen from its parts: the shared indicator while they come, then nothing once all came; a part that
   failed says why, and a load past its one limit says it takes longer than usual, each with Try again, which asks again
   for what is missing. The clock goes only as far as a test moves it. */
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('hh-lang', 'en');
});
afterEach(() => vi.useRealTimers());

function Shown({ parts }: { parts: LoadPart[] }) {
  const load = useLoad(parts);
  return <LanguageProvider><LoadState load={load} /><i className="phase">{load.phase}</i></LanguageProvider>;
}

const part = (data: unknown, failure: unknown = null, load = vi.fn()): LoadPart => ({ data, failure, load });
const later = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('one load of a screen', () => {
  it('stands where the data will be while a part is missing, and goes once all came', () => {
    const { rerender, container } = render(<Shown parts={[part([1]), part(null)]} />);
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(1);
    rerender(<Shown parts={[part([1]), part([])]} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.phase')?.textContent).toBe('done');
  });

  it('has one limit for the whole load, not one per part, and past it says it takes longer than usual', () => {
    const { rerender } = render(<Shown parts={[part(undefined), part(undefined)]} />);
    later(LOAD_LIMIT_MS - 5_000);
    rerender(<Shown parts={[part([1]), part(undefined)]} />);
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    later(5_000);
    expect(screen.getByRole('alert').textContent).toBe(en.common.tooLong);
    expect(screen.getByText(en.common.stillComing)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelectorAll('.waiting-mark')).toHaveLength(0);
  });

  it('asks again on Try again for only what is missing, and starts the limit over', () => {
    const came = part([1]);
    const missing = part(undefined);
    render(<Shown parts={[came, missing]} />);
    later(LOAD_LIMIT_MS);
    fireEvent.click(screen.getByRole('button', { name: en.app.tryAgain }));
    expect(missing.load).toHaveBeenCalledTimes(1);
    expect(came.load).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    later(LOAD_LIMIT_MS - 1);
    expect(screen.queryByRole('alert')).toBeNull();
    later(1);
    expect(screen.getByRole('alert').textContent).toBe(en.common.tooLong);
  });

  it('says why a part failed, and after Try again counts only a new failure while the part is asked again', () => {
    const first = new Error('first');
    const failed = part(undefined, first);
    const { rerender, container } = render(<Shown parts={[failed]} />);
    expect(screen.getByRole('alert').textContent).toBe(en.errors.codes.internal);
    expect(container.querySelectorAll('.waiting-mark')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: en.app.tryAgain }));
    expect(failed.load).toHaveBeenCalledTimes(1);
    rerender(<Shown parts={[{ ...failed }]} />);
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    rerender(<Shown parts={[{ ...failed, failure: new Error('second') }]} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Shown parts={[{ ...failed, data: [], failure: null }]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.phase')?.textContent).toBe('done');
  });

  it('says nothing of a part that failed after its data came', () => {
    const { container } = render(<Shown parts={[part([1], new Error('a later read failed'))]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.phase')?.textContent).toBe('done');
  });
});
