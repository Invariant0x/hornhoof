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

/* What the window's one button and the update's progress bar are called to a screen reader, in English like the lines. */
export const SERVICE_CLOSE = 'Close';
