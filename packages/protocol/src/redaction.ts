/* What hides credentials and private places in diagnostics, one list for the node's own logs and for what Hornhoof shows of
   one department's failures to another. Exact copies of secrets a program let the node learn are hidden where it knows them. */

export const HIDDEN = '[hidden]';

/* An install command belongs to the person it was made for; a conversation never keeps its join code. */
export const hideJoinCodes = (text: string): string => text.replace(/--join [A-Za-z0-9_-]+/g, `--join ${HIDDEN}`);

type Pattern = readonly [{ [Symbol.replace](text: string, replacement: string): string }, string];

/* The shortest secret hidden by its exact value: shorter ones would hide ordinary words. */
export const MIN_SECRET_LENGTH = 8;

/* A password after its label, with = or :, quoted or not. */
const LABELLED_PASSWORD: Pattern = [/((?<![\p{L}\p{N}_])(?:пароль|password|passwd)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/giu, `$1${HIDDEN}`];
/* A password right after its label: quoted, or one word of six characters or more with a digit or a sign, never a task number. */
const NAMED_PASSWORD: Pattern = [/((?<![\p{L}\p{N}_])(?:пароль|password|passwd)\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|(?!#)(?=[^\s,;]{6})(?=[^\s,;]*[\d!@#$%])[^\s,;]+)/giu, `$1${HIDDEN}`];
const PRIVATE_KEY: Pattern = [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, HIDDEN];
/* Find the fixed delimiter before checking a scheme. Scheme runs before different delimiters cannot overlap. */
function hasSchemeBefore(text: string, at: number): boolean {
  let letter = false;
  for (let i = at - 1; i >= 0; i -= 1) {
    const char = text.charAt(i);
    if (/[a-z]/i.test(char)) letter = true;
    else if (!/[0-9+.-]/.test(char)) break;
  }
  return letter;
}

/* Sticky: inspect only the user/password immediately after this delimiter, never search the remainder for one. */
const URL_USERINFO = /[^/\s:@]+:[^/\s@]+@/y;

function hideUrlPasswords(text: string): string {
  const parts: string[] = [];
  let from = 0, kept = 0;
  for (let at = text.indexOf('://', from); at >= 0; at = text.indexOf('://', from)) {
    from = at + 3;
    if (!hasSchemeBefore(text, at)) continue;
    URL_USERINFO.lastIndex = from;
    if (!URL_USERINFO.exec(text)) continue;
    parts.push(text.slice(kept, from), HIDDEN, '@');
    kept = from = URL_USERINFO.lastIndex;
  }
  parts.push(text.slice(kept));
  return parts.join('');
}

const URL_PASSWORD: Pattern = [{ [Symbol.replace]: hideUrlPasswords }, ''];
const KNOWN_TOKEN: Pattern = [/\b(?:sk-(?:ant-)?[a-z0-9_-]{8,}|ghp_[a-z0-9]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16}|AGE-SECRET-KEY-[A-Z0-9]+)/gi, HIDDEN];
const JWT: Pattern = [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, HIDDEN];

/* Credentials by their shape, for those a program has not let anyone learn yet. */
export const CREDENTIALS: readonly Pattern[] = [
  LABELLED_PASSWORD,
  NAMED_PASSWORD,
  PRIVATE_KEY,
  [/\b(?:Proxy-Authorization|Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, HIDDEN],
  [/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, HIDDEN],
  [/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|password|passwd|secret|client[_-]?secret|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, `$1${HIDDEN}`],
  [/(--(?:join|token|password|key|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${HIDDEN}`],
  [/([?&](?:code|token|key|secret|password)=)[^&\s]*/gi, `$1${HIDDEN}`],
  URL_PASSWORD,
  KNOWN_TOKEN,
  JWT,
];

/* What stored prose loses as it is written: a labelled password and credentials of a known format. Headers, flags, query
   strings and assignments to words like key or token are hidden only in diagnostics, since tasks, chats and skills quote
   code and words like "basic rules" as ordinary text. */
export const PROSE_CREDENTIALS: readonly Pattern[] = [LABELLED_PASSWORD, NAMED_PASSWORD, PRIVATE_KEY, URL_PASSWORD, KNOWN_TOKEN, JWT];

/* A path in someone's home or user folder names the person and what they keep there. */
export const PRIVATE_PATHS: readonly Pattern[] = [
  [/(?<![\w.~/-])(?:\/(?:data\/|var\/)?home|\/Users|\/root)(?=[/\s'"`]|$)[^\s'"`<>()[\]{},;]*/g, HIDDEN],
  [/(?<![\w])[A-Za-z]:\\Users\\[^\s'"`<>()[\]{},;]*/g, HIDDEN],
];

export const hiddenBy = (text: string, patterns: readonly Pattern[]): string => patterns.reduce((out, [pattern, hidden]) => out.replace(pattern, hidden), text);

/* Stored prose keeps its paths and structure, with credentials removed before it is copied or archived. */
export const hideCredentials = (text: string): string => hiddenBy(text, PROSE_CREDENTIALS);

export function hideCredentialsIn<T>(value: T): T;
export function hideCredentialsIn(value: unknown): unknown {
  if (typeof value === 'string') return hideCredentials(value);
  if (Array.isArray(value)) return value.map(item => hideCredentialsIn(item));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideCredentialsIn(item)]));
  }
  return value;
}

/* A diagnostic with no credential and no private path in it, for a reader who may not read where it comes from. Clean it
   before cutting it, so that no part of either is left at the edge. */
export const cleanDiagnostic = (text: string): string => hiddenBy(hiddenBy(text, CREDENTIALS), PRIVATE_PATHS);
