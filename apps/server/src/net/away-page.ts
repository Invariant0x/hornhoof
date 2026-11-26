/* The page a browser gets when the front or a keeper has no live server behind it (#1938, #2049): the server is away, or an
   update installs. It shows only the Hornhoof logo and one English line, centred on a plain background in light or dark by
   the browser's preference, refreshes itself so it becomes the app once the server answers, and makes no outside request. */
import { BOOT_STYLE, BOOT_WORDS, SERVICE_LINES, type Away } from '@hornhoof/protocol/service-lines';

export type { Away };

const LINE: Record<Away, string> = { lost: SERVICE_LINES.lost, updating: SERVICE_LINES.updating };

/* How often the page asks again, in seconds: the Retry-After the answer carries. */
const EVERY_S: Record<Away, number> = { lost: 5, updating: 10 };
export const awayEveryS = (kind: Away): number => EVERY_S[kind];

export const awayText = (kind: Away): string => `${LINE[kind]}\n`;

/* The mark of Hornhoof, as the app draws it: dome in accent, base and dot in ink. */
const SIGN = `<svg class="boot-mark" viewBox="0 0 30 30" aria-hidden="true"><path class="mk-dome" d="M 5 20 A 10 10 0 0 1 25 20"/><path class="mk-base" d="M 2 24.5 L 28 24.5"/><circle class="mk-dot" cx="15" cy="16" r="2.4"/></svg>`;

const STYLE = `
:root { color-scheme: light dark; --bg: #E6EBF0; --ink: #0F1B27; --muted: #4C5A68; --cyan: #00A3BD; }
@media (prefers-color-scheme: dark) { :root { --bg: #141A22; --ink: #E3EAF1; --muted: #93A0AE; --cyan: #46E0EF; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 400 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { display: grid; justify-items: center; gap: 16px; max-inline-size: min(100%, 60ch); text-align: center; }
p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
`;

const UPDATING = `<main class="boot-screen" role="status" aria-busy="true">
${SIGN}
<p class="boot-line"><span class="boot-label">${BOOT_WORDS.updating}…</span><span class="boot-word" aria-hidden="true" data-word="${BOOT_WORDS.updating}"></span><span class="boot-dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
</main>`;

const LOST = `<main role="status">
${SIGN}
<p>${LINE.lost}</p>
</main>`;

export function awayPage(kind: Away): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta http-equiv="refresh" content="${awayEveryS(kind)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hornhoof</title>
<style>${STYLE}${BOOT_STYLE}</style>
</head>
<body>
${kind === 'updating' ? UPDATING : LOST}
</body>
</html>
`;
}
