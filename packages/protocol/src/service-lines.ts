/* The one English line of each service state (#2098, #2099, Design #2100): the window, the strip and the loader of the web app
   say it, and so does the page the front and a keeper answer a browser with while no server is behind them (#2049). Every
   language reads the same words, so the person finds the same line wherever the state shows. */

/* Why a server cannot be reached: it does not answer, or it installs an update. */
export type Away = 'lost' | 'updating';

export const SERVICE_LINES = {
  offline: 'No internet',
  lost: 'No connection',
  updating: 'Updating',
  signedOut: 'Signed out',
} as const;

/* What the window's one button is called to a screen reader. */
export const SERVICE_CLOSE = 'Close';

/* The front has no app bundle while the server updates. Both entry points use the same loader CSS. */
export const BOOT_STYLE = `
.boot-screen { position: absolute; inset: 0; max-inline-size: none; display: grid; justify-items: center; align-content: center; gap: 16px; padding: 16px; text-align: center; }
.boot-mark { display: block; inline-size: 48px; block-size: 48px; }
.boot-mark .mk-dome { fill: none; stroke: var(--cyan); stroke-width: 2.4; }
.boot-mark .mk-base { fill: none; stroke: var(--ink); stroke-width: 2.4; }
.boot-mark .mk-dot { fill: var(--ink); }
.boot-line { position: relative; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.boot-label { position: absolute; clip-path: inset(50%); inline-size: 1px; block-size: 1px; overflow: hidden; white-space: nowrap; }
.boot-word::before { content: attr(data-word); }
.boot-dots { display: inline-flex; gap: .12em; margin-inline-start: .12em; }
.boot-dots > i { inline-size: .12em; block-size: .12em; border-radius: 50%; background: currentColor; animation: boot-dot 1.2s ease-in-out var(--boot-dot-delay, 0s) infinite; }
.boot-dots > i:nth-child(2) { --boot-dot-delay: .2s; }
.boot-dots > i:nth-child(3) { --boot-dot-delay: .4s; }
@keyframes boot-dot { 0%, 60%, 100% { opacity: .35; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .boot-dots > i { animation: none; } }
`;
