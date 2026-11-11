import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/* A person this close to the end of the chat still reads its newest line: a browser can stop a pixel short of it. */
const NEAR_END = 1;

/* The lines a chat holds as it comes on the screen are its history, not news: they show at once, without the entrance a new
   line makes. A browser plays that entrance for every line as the chat first shows, and again each time a hidden window shows.
   jsdom has no animations to finish; a looping one has no end to jump to. */
function settle(log: HTMLElement): void {
  for (const line of log.children) {
    if (typeof line.getAnimations !== 'function') return;
    for (const motion of line.getAnimations()) if (motion.effect?.getTiming().iterations !== Infinity) motion.finish();
  }
}

/* Where the chat stands: on its newest line from the first frame it shows, whether it just opened or comes back from behind
   another chat; and there while it stays open, as long as the person reads at its end. Someone who scrolled up to read stays
   where they read. shown: the chat is on the screen; end: what changes at its end, such as its lines and whether the agent
   works. */
export function useChatScroll(shown: boolean, end: string): { log: RefObject<HTMLDivElement | null>; onScroll(): void } {
  const log = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const wasShown = useRef(false);
  /* Where the chat put itself last. A scroll the browser tells of while it still stands there is its own move, though its
     lines grew under it meanwhile as pictures loaded. */
  const put = useRef<number | null>(null);

  /* Whether the person reads at the end goes by where they scrolled to. The browser moves the chat by itself too as lines
     come, such as to keep what is on the screen in place, so where it stands after a change says nothing of the person. */
  const onScroll = useCallback(() => {
    const el = log.current;
    if (!el || el.scrollTop === put.current) return;
    put.current = null;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_END;
  }, []);

  useLayoutEffect(() => {
    const el = log.current;
    const coming = shown && !wasShown.current;
    wasShown.current = shown;
    if (!el || !shown) return;
    if (coming) {
      settle(el);
      atEnd.current = true;
    }
    if (!atEnd.current) return;
    el.scrollTop = el.scrollHeight;
    put.current = el.scrollTop;
  }, [shown, end]);

  return { log, onScroll };
}
