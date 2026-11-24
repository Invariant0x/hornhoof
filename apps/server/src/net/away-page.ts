/* The page a browser gets, in place of an unstyled line, when the front or a keeper has no live server behind it (#1938):
   the server is away, or an update installs. It speaks one language, the first of the visitor's Accept-Language that
   Hornhoof ships, English otherwise; says what happened in plain words; says how often it asks again and does ask, by
   itself, so it becomes the app once the server answers; and has a button to ask at once. It wraps at any width and makes
   no request of its own: no font, no image, no link, nothing but its own text, style and one line of script, which a policy
   of its own lets run and nothing else, so it shows the same with no internet. Its colours are the tokens of the style
   book, light and dark by the visitor's setting. */
import { directionOf, isSourceLocale, localeOfHeader, SOURCE_LOCALE, type LocaleId } from '@hornhoof/protocol';
import { wordsFor } from '../locales/index.js';

export type Away = 'lost' | 'updating';

/* How often the page asks again, in seconds: the Retry-After the answer carries. */
const EVERY_S: Record<Away, number> = { lost: 5, updating: 10 };
export const awayEveryS = (kind: Away): number => EVERY_S[kind];

/* The first language of an Accept-Language header that Hornhoof ships, by the weights the visitor gave, or English. */
export const languageOf = (header: string | undefined): LocaleId => localeOfHeader(header);

/* The sign of Hornhoof, as the app draws it, in the ink colour. */
const SIGN = `<svg class="sign" viewBox="0 0 30 30" width="48" height="48" aria-hidden="true"><path d="M 5 20 A 10 10 0 0 1 25 20" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M 2 24.5 L 28 24.5" stroke="currentColor" stroke-width="2.4"/><circle cx="15" cy="16" r="2.4" fill="currentColor"/></svg>`;

const STYLE = `
:root { color-scheme: light dark; --bg: #E6EBF0; --surface: #F8FAFC; --line2: #768695; --ink: #0F1B27; --muted: #4C5A68; --cyan: #00A3BD; --cyan-ink: #006E80; --btn: #00768A; --on-btn: #FFFFFF; }
@media (prefers-color-scheme: dark) { :root { --bg: #141A22; --surface: #1B232D; --line2: #687A8F; --ink: #E3EAF1; --muted: #93A0AE; --cyan: #46E0EF; --cyan-ink: #6FE9F5; --btn: #46E0EF; --on-btn: #05222A; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 400 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { inline-size: min(440px, 100%); display: grid; gap: 12px; padding: 20px; background: var(--surface); border: 1px solid var(--line2); border-block-start: 2px solid var(--cyan); }
.sign { color: var(--ink); margin-block-end: 4px; }
h1 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.15; overflow-wrap: anywhere; }
p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
p.checking { font-size: 13px; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; }
button { --cut: 7px; min-block-size: 44px; padding: 8px 18px; border: 0; cursor: pointer; background: var(--btn); color: var(--on-btn); font: 600 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut))); }
button:hover { filter: brightness(1.08); }
button:focus-visible { clip-path: none; outline: 2px solid var(--cyan-ink); outline-offset: 2px; }
`;

/* The words of a plain answer, for a client that asks for no page: English, which a program reads, and the language of the
   visitor under it when it is another. */
export type AwayText = keyof ReturnType<typeof wordsFor>['away']['text'];
export function awayText(key: AwayText, acceptLanguage?: string): string {
  const language = languageOf(acceptLanguage);
  const english = wordsFor(SOURCE_LOCALE).away.text[key];
  return `${isSourceLocale(language) ? english : `${english}\n${wordsFor(language).away.text[key]}`}\n`;
}

export function awayPage(kind: Away, acceptLanguage?: string): string {
  const language = languageOf(acceptLanguage);
  const words = wordsFor(language).away;
  const [title, hint] = words[kind];
  const every = awayEveryS(kind);
  return `<!doctype html>
<html lang="${language}" dir="${directionOf(language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta http-equiv="refresh" content="${every}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hornhoof</title>
<style>${STYLE}</style>
<noscript><style>.actions { display: none; }</style></noscript>
</head>
<body>
<main role="status">
${SIGN}
<h1>${title}</h1>
<p>${hint}</p>
<p class="checking">${words.checking(every)}</p>
<div class="actions"><button type="button" onclick="location.reload()">${words.reload}</button></div>
</main>
</body>
</html>
`;
}
