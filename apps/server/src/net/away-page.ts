/* The page a browser gets, in place of an unstyled line, when the front or a keeper has no live server behind it (#1938):
   the server is away, or an update installs. It says so in plain words in English and in Russian, one under the other,
   wraps at any width, asks again by itself, and makes no request of its own: no script, no image, no font, no link, and a
   policy of its own that forbids them, so it shows the same with no internet. Its colours are the tokens of the style
   book, light and dark by the visitor's setting. */
export type Away = 'lost' | 'updating';

const WORDS = {
  lost: {
    en: ['No connection to the server', 'Hornhoof keeps trying, and this page opens by itself when the server answers. You do not need to reload it.'],
    ru: ['Нет связи с сервером', 'Hornhoof пробует снова, и эта страница откроется сама, когда сервер ответит. Перезагружать ее не нужно.'],
    everyS: 5,
  },
  updating: {
    en: ['Server is updating', 'This takes a few minutes. This page opens by itself when the update ends. You do not need to reload it.'],
    ru: ['Сервер обновляется', 'Это займет несколько минут. Эта страница откроется сама, когда обновление закончится. Перезагружать ее не нужно.'],
    everyS: 10,
  },
} as const;

/* How often the page asks again, in seconds: the Retry-After the answer carries. */
export const awayEveryS = (kind: Away): number => WORDS[kind].everyS;

const STYLE = `
:root { color-scheme: light dark; --bg: #E6EBF0; --surface: #F8FAFC; --line2: #768695; --ink: #0F1B27; --muted: #4C5A68; --cyan: #00A3BD; }
@media (prefers-color-scheme: dark) { :root { --bg: #141A22; --surface: #1B232D; --line2: #687A8F; --ink: #E3EAF1; --muted: #93A0AE; --cyan: #46E0EF; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { inline-size: min(440px, 100%); display: grid; gap: 18px; padding: 18px; background: var(--surface); border: 1px solid var(--line2); border-block-start: 2px solid var(--cyan); }
section { display: grid; gap: 6px; }
h1 { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
section + section { padding-block-start: 18px; border-block-start: 1px solid var(--line2); }
`;

export function awayPage(kind: Away): string {
  const { en, ru, everyS } = WORDS[kind];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta http-equiv="refresh" content="${everyS}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hornhoof</title>
<style>${STYLE}</style>
</head>
<body>
<main role="status">
<section lang="en"><h1>${en[0]}</h1><p>${en[1]}</p></section>
<section lang="ru"><h1>${ru[0]}</h1><p>${ru[1]}</p></section>
</main>
</body>
</html>
`;
}
