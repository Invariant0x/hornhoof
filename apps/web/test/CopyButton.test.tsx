import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CopyButton } from '../src/ui/CopyButton';

beforeEach(() => {
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

async function copy() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
}

describe('CopyButton', () => {
  it('removes the copied message after 1600 ms', async () => {
    render(<CopyButton text="command" />);
    await copy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('command');
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    await act(() => vi.advanceTimersByTime(1599));
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    await act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the pending reset when the button closes', async () => {
    const { unmount, container } = render(<CopyButton text="command" />);
    await copy();
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.runAllTimers());
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps only the latest reset when copying again', async () => {
    render(<CopyButton text="command" />);
    await copy();
    await act(() => vi.advanceTimersByTime(1000));
    await copy();
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    await act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a reset if copying finishes after the button closes', async () => {
    let finish!: () => void;
    vi.mocked(navigator.clipboard.writeText).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const { unmount } = render(<CopyButton text="command" />);
    await copy();
    unmount();
    await act(async () => { finish(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the label and timers alone when the clipboard rejects the copy', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('blocked'));
    render(<CopyButton text="command" label="Copy command" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command' })); });
    expect(screen.getByRole('button')).toHaveTextContent('Copy command');
    expect(vi.getTimerCount()).toBe(0);
  });
});
