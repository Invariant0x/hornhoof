import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStream } from '../src/live';
import { fakeStream } from './fake-stream';

function Listener({ onMessage }: { onMessage: (m: unknown) => void }) {
  useStream(onMessage);
  return null;
}

describe('useStream', () => {
  it('shares one stream between everyone who listens on the page', () => {
    const stream = fakeStream();
    const a = vi.fn();
    const b = vi.fn();
    const { unmount } = render(
      <>
        <Listener onMessage={a} />
        <Listener onMessage={b} />
      </>,
    );
    expect(stream.sources()).toHaveLength(1);
    expect(stream.sources()[0]!.url).toBe('/api/stream');
    stream.send({ type: 'working', working: 2 });
    expect(a).toHaveBeenCalledWith({ type: 'working', working: 2 });
    expect(b).toHaveBeenCalledWith({ type: 'working', working: 2 });
    unmount();
    expect(stream.sources()[0]!.closed).toBe(true);
  });

  it('says when the stream came back after a break, so listeners catch up', () => {
    const stream = fakeStream();
    const heard = vi.fn();
    render(<Listener onMessage={heard} />);
    const source = stream.sources()[0]!;
    act(() => source.fire('open'));
    expect(heard).not.toHaveBeenCalled();
    act(() => {
      source.fire('error');
      source.fire('open');
    });
    expect(heard).toHaveBeenCalledWith({ type: 'reconnected' });
  });
});
