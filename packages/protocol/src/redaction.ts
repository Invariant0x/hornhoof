/* What hides credentials and private places in diagnostics, one list for the node's own logs and for what Hornhoof shows of
   one department's failures to another. Exact copies of secrets a program let the node learn are hidden where it knows them. */

export const HIDDEN = '[hidden]';

type Pattern = readonly [RegExp, string];

/* Credentials by their shape, for those a program has not let anyone learn yet. */
export const CREDENTIALS: readonly Pattern[] = [
  [/((?<![\p{L}\p{N}_])(?:пароль|password|passwd)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/giu, `$1${HIDDEN}`],
  [/((?<![\p{L}\p{N}_])(?:пароль|password|passwd)\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|(?=[^\s,;]*[\d!@#$%])[^\s,;]+)/giu, `$1${HIDDEN}`],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, HIDDEN],
  [/\b(?:Proxy-Authorization|Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, HIDDEN],
  [/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, HIDDEN],
  [/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|password|passwd|secret|client[_-]?secret|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, `$1${HIDDEN}`],
  [/(--(?:join|token|password|key|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${HIDDEN}`],
  [/([?&](?:code|token|key|secret|password)=)[^&\s]*/gi, `$1${HIDDEN}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${HIDDEN}@`],
  [/\b(?:sk-(?:ant-)?[a-z0-9_-]{8,}|ghp_[a-z0-9]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16}|AGE-SECRET-KEY-[A-Z0-9]+)/gi, HIDDEN],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, HIDDEN],
];

/* A path in someone's home or user folder names the person and what they keep there. */
export const PRIVATE_PATHS: readonly Pattern[] = [
  [/(?<![\w.~/-])(?:\/(?:data\/|var\/)?home|\/Users|\/root)(?=[/\s'"`]|$)[^\s'"`<>()[\]{},;]*/g, HIDDEN],
  [/(?<![\w])[A-Za-z]:\\Users\\[^\s'"`<>()[\]{},;]*/g, HIDDEN],
];

export const hiddenBy = (text: string, patterns: readonly Pattern[]): string => patterns.reduce((out, [pattern, hidden]) => out.replace(pattern, hidden), text);

/* Stored prose keeps its paths and structure, with credentials removed before it is copied or archived. */
export const hideCredentials = (text: string): string => hiddenBy(text, CREDENTIALS);

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
