import { getConfig } from '@testing-library/react';

/* Waits for what the app does next, with no clock of its own. A find* query allows one second, and the first thing a test file
   renders is cold code, so on a busy machine that second measures the machine. The test's own limit still ends a wait for
   something that never comes. */
export function until<T>(find: () => T | null): Promise<T> {
  return getConfig().asyncWrapper(
    () =>
      new Promise<T>(done => {
        const look = () => {
          const found = find();
          if (found === null) return;
          watch.disconnect();
          done(found);
        };
        const watch = new MutationObserver(look);
        watch.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        look();
      }),
  ) as Promise<T>;
}
