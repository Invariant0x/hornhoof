import { act, render, screen } from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { connection } from '../src/connection';
import { useStream } from '../src/live';
import { fakeStream } from './fake-stream';

function Listener({ onMessage }: { onMessage: (m: unknown) => void }) {
  useStream(onMessage);
  return null;
}

/* A listener that reads the newest word, and a sibling after it that gets a message the moment the word changes:
   after the screen shows it, before React's passive effects run. */
function Handler({ word, heard }: { word: string; heard: (word: string, m: unknown) => void }) {
  useStream(m => heard(word, m));
  return <p>{word}</p>;
}

function Arrives({ word, fire }: { word: string; fire: () => void }) {
  useLayoutEffect(() => {
    if (word === 'ready') fire();
  }, [word, fire]);
  return null;
}

function Late({ heard, fire }: { heard: (word: string, m: unknown) => void; fire: () => void }) {
  const [word, setWord] = useState('waiting');
  useEffect(() => {
    void Promise.resolve().then(() => setWord('ready'));
  }, []);
  return (
    <>
      <Handler word={word} heard={heard} />
      <Arrives word={word} fire={fire} />
    </>
  );
}

describe('useStream', () => {
  it('hands a message to the handler of the newest render, even right after it shows', async () => {
    const stream = fakeStream();
    const heard = vi.fn();
    render(<Late heard={heard} fire={() => stream.sources()[0]!.fire('message', { type: 'org' })} />);
    await screen.findByText('ready');
    expect(heard).toHaveBeenCalledWith('ready', { type: 'org' });
  });

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

  it('opens the stream again at once, not at its own wait, when the server answers after it was away', async () => {
    vi.useFakeTimers();
    try {
      const stream = fakeStream();
      const heard = vi.fn();
      vi.stubGlobal('fetch', vi.fn<() => Promise<Response>>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(new Response('{"build":"b1"}')));
      const { unmount } = render(<Listener onMessage={heard} />);
      act(() => {
        stream.sources()[0]!.readyState = 2;
        stream.sources()[0]!.fire('error');
      });
      /* The look at the server fails: it is away, and the stream is closed for good until it opens again. */
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(connection.snapshot().away).toBe('lost');
      expect(stream.sources()).toHaveLength(1);
      /* The next look answers, well before the stream's own second. */
      await act(async () => {
        connection.tryNow();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(connection.snapshot().away).toBeNull();
      expect(stream.sources()).toHaveLength(2);
      expect(heard).toHaveBeenCalledWith({ type: 'reconnected' });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a new stream when the browser gives up on the old one, and says it came back', () => {
    vi.useFakeTimers();
    try {
      const stream = fakeStream();
      const heard = vi.fn();
      render(<Listener onMessage={heard} />);
      const first = stream.sources()[0]!;
      act(() => {
        first.readyState = 2;
        first.fire('error');
      });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(first.closed).toBe(true);
      expect(stream.sources()).toHaveLength(2);
      act(() => stream.sources()[1]!.fire('open'));
      expect(heard).toHaveBeenCalledWith({ type: 'reconnected' });
    } finally {
      vi.useRealTimers();
    }
  });
});
