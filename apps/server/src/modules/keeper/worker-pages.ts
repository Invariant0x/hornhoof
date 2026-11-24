import type http from 'node:http';
import { directionOf, isSourceLocale, localeOfHeader, SOURCE_LOCALE } from '@hornhoof/protocol';
import { wordsFor } from '../../locales/index.js';
import { startingAnswer, type Refusal } from '../../net/proxy.js';
import type { DataMachine } from '../network/join.js';

const HTML = 'text/html; charset=utf-8';
const NO_LEADER_JSON = JSON.stringify({ error: { code: 'unavailable', message: 'This machine cannot reach the company server now.', reason: 'no_leader' } });
const DISCONNECTED_JSON = JSON.stringify({
  error: { code: 'gone', message: 'This machine was disconnected from the company. To connect it again, get a new command in Hornhoof under Machines and run it here.', reason: 'disconnected' },
});

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escaped = (text: string): string => text.replace(/[&<>"']/g, char => ESCAPES[char]!);

/* startingAnswer already decides who gets JSON and who gets a page, so these answers split as every other does. */
const wantsJson = (req: http.IncomingMessage): boolean => startingAnswer(req).headers['Content-Type'] === 'application/json';

/* A page with no script that asks again by itself, in English and under it in the visitor's language when that is another,
   as every page a keeper serves itself. */
function page(title: string, blocks: readonly { language: string; html: string }[]): string {
  const [english, ...others] = blocks;
  return `<!doctype html>
<html lang="${english!.language}">
<head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
${english!.html}
${others.map(block => `<div lang="${block.language}" dir="${directionOf(block.language)}">\n${block.html}\n</div>\n`).join('')}</body>
</html>
`;
}

/* The language of the visitor and English: one when the visitor reads English. */
const languagesOf = (req: http.IncomingMessage): string[] => {
  const own = localeOfHeader(String(req.headers['accept-language'] ?? ''));
  return isSourceLocale(own) ? [SOURCE_LOCALE] : [SOURCE_LOCALE, own];
};

function places(view: { data: DataMachine[]; linkUrl: string | null }, words: { server: string; or: (url: string) => string }): string {
  const items = view.data.filter(machine => machine.webPort).map(machine => `<li>${escaped(machine.hostname || words.server)}: localhost:${machine.webPort}</li>`);
  const link = view.linkUrl ? `<p>${words.or(`<a href="${escaped(view.linkUrl)}">${escaped(view.linkUrl)}</a>`)}</p>` : '';
  return `${items.length ? `<ul>\n${items.join('\n')}\n</ul>` : ''}\n${link}`;
}

/* What a worker answers while it reaches no leader: where the company can be opened meanwhile. A program gets JSON. */
export function noLeaderAnswer(req: http.IncomingMessage, view: { data: DataMachine[]; linkUrl: string | null }): Refusal {
  const headers = { 'Retry-After': '15', 'Cache-Control': 'no-store' };
  if (wantsJson(req)) return { status: 503, headers: { ...headers, 'Content-Type': 'application/json' }, body: NO_LEADER_JSON };
  const blocks = languagesOf(req).map(language => {
    const words = wordsFor(language).worker;
    return { language, html: `<p>${words.noLeader}</p>\n${places(view, { server: words.server, or: words.orAt })}` };
  });
  return { status: 503, headers: { ...headers, 'Content-Type': HTML }, body: page('Hornhoof', blocks) };
}

/* What a worker answers once the company cut it off. */
export function disconnectedAnswer(req: http.IncomingMessage): Refusal {
  const headers = { 'Cache-Control': 'no-store' };
  if (wantsJson(req)) return { status: 410, headers: { ...headers, 'Content-Type': 'application/json' }, body: DISCONNECTED_JSON };
  const blocks = languagesOf(req).map(language => ({ language, html: `<p>${wordsFor(language).worker.disconnected}</p>` }));
  return { status: 410, headers: { ...headers, 'Content-Type': HTML }, body: page('Hornhoof', blocks) };
}
