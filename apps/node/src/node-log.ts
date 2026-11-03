import { NODE_LOG_BYTES, NODE_LOG_LINES } from '@hornhoof/protocol';
import { stripVTControlCharacters } from 'node:util';
import { HIDDEN, redact } from './redact.js';

/* These are node diagnostics, not agent output. Labels protect secrets a program has not let the node learn yet. */
const CREDENTIALS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, HIDDEN],
  [/\b(?:Proxy-Authorization|Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, HIDDEN],
  [/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, HIDDEN],
  [/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|password|passwd|secret|client[_-]?secret|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, `$1${HIDDEN}`],
  [/(--(?:join|token|password|key|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${HIDDEN}`],
  [/([?&](?:code|token|key|secret|password)=)[^&\s]*/gi, `$1${HIDDEN}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${HIDDEN}@`],
  [/\b(?:sk-(?:ant-)?[a-z0-9_-]{8,}|ghp_[a-z0-9]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16}|AGE-SECRET-KEY-[A-Z0-9]+)/gi, HIDDEN],
];

/* Move a byte cut to the next character boundary rather than creating a replacement character. */
function byteTail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(0, bytes.length - NODE_LOG_BYTES);
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function nodeLog(text: string, secrets: string[]): string {
  let clean = redact(stripVTControlCharacters(text), secrets);
  for (const [pattern, replacement] of CREDENTIALS) clean = clean.replace(pattern, replacement);
  const lines = clean.replace(/\r\n?/g, '\n').split('\n').slice(-NODE_LOG_LINES).join('\n');
  return byteTail(lines);
}

/* A private key may span callbacks. Hide it from its opening line until its closing line arrives. */
export function nodeLogStream(): (text: string, secrets: string[]) => string {
  let privateKey = false;
  return (text, secrets) => {
    const lines = stripVTControlCharacters(text).split(/\r?\n/).map(line => {
      if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) privateKey = true;
      const clean = privateKey ? HIDDEN : line;
      if (/-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) privateKey = false;
      return clean;
    });
    return nodeLog(lines.join('\n'), secrets);
  };
}
