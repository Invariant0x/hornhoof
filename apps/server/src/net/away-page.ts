/* The page a browser gets, in place of an unstyled line, when the front or a keeper has no live server behind it (#1938):
   the server is away, or an update installs. It shows the sign of Hornhoof and one line under it, in English whatever the
   browser speaks, "No connection" or "Updating" (#2049), centred on a plain background, and nothing else. It asks again by
   itself, invisibly, by its own refresh, so it becomes the app once the server answers. It makes no request of its own: no
   font, no image, no link, no script, nothing but its own text and style, which a policy of its own lets act and nothing
   else, so it shows the same with no internet. Its colours are the tokens of the style book, light and dark by the visitor's
   setting. */
export type Away = 'lost' | 'updating';

/* The one line of each state: also what a client that is neither a browser nor a program reads, as text. */
const LINE: Record<Away, string> = { lost: 'No connection', updating: 'Updating' };
export const awayLine = (kind: Away): string => LINE[kind];

/* How often the page asks again, in seconds: the Retry-After the answer carries. */
const EVERY_S: Record<Away, number> = { lost: 5, updating: 10 };
export const awayEveryS = (kind: Away): number => EVERY_S[kind];

/* The sign of Hornhoof, as the app draws it: the dome in the accent, the base and the dot in the ink. */
const SIGN = `<svg class="sign" viewBox="0 0 30 30" width="48" height="48" aria-hidden="true"><path class="dome" d="M 5 20 A 10 10 0 0 1 25 20"/><path class="base" d="M 2 24.5 L 28 24.5"/><circle class="dot" cx="15" cy="16" r="2.4"/></svg>`;

const STYLE = `
:root { color-scheme: light dark; --bg: #E6EBF0; --ink: #0F1B27; --cyan: #00A3BD; }
@media (prefers-color-scheme: dark) { :root { --bg: #141A22; --ink: #E3EAF1; --cyan: #46E0EF; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 600 18px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { display: grid; justify-items: center; gap: 12px; max-inline-size: 100%; text-align: center; }
.dome { fill: none; stroke: var(--cyan); stroke-width: 2.4; }
.base { stroke: var(--ink); stroke-width: 2.4; }
.dot { fill: var(--ink); }
p { margin: 0; overflow-wrap: anywhere; }
`;

export function awayPage(kind: Away): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta http-equiv="refresh" content="${awayEveryS(kind)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hornhoof</title>
<style>${STYLE}</style>
</head>
<body>
<main role="status">
${SIGN}
<p>${awayLine(kind)}</p>
</main>
</body>
</html>
`;
}
