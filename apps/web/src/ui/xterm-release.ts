import type { Terminal } from '@xterm/xterm';

/* What of xterm 5.5 keeps a closed terminal alive: the monitor of the screen's pixel density that its browser service makes
   for every terminal it opens and never disposes. Its listeners on the window's resize and on a media query hold the
   service, and through it the whole terminal with its scrollback, for as long as the page lives. */
type WithDensityMonitor = { _core?: { _coreBrowserService?: { _screenDprMonitor?: { dispose?: () => void } } } };

/* Closes the terminal and the monitor xterm leaves behind; a terminal that never opened has none. */
export function disposeTerminal(term: Terminal): void {
  const monitor = (term as unknown as WithDensityMonitor)._core?._coreBrowserService?._screenDprMonitor;
  term.dispose();
  monitor?.dispose?.();
}
