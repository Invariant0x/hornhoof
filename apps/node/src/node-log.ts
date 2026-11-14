import { NODE_LOG_BYTES, NODE_LOG_LINES } from '@hornhoof/protocol';
import { stripVTControlCharacters } from 'node:util';
import { CREDENTIALS } from '@hornhoof/protocol/redaction';
import { HIDDEN, redact } from './redact.js';

/* These are node diagnostics, not agent output. Credentials by their shape (CREDENTIALS) and the labels below protect secrets
   a program has not let the node learn yet. */
type Redaction = { privateKey: boolean; quote: string | null; header: boolean };
const redaction = (): Redaction => ({ privateKey: false, quote: null, header: false });
const QUOTED = /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|password|passwd|secret|client[_-]?secret|credential)["']?\s*[:=]\s*)(["'])/i;
const HEADER = /\b(?:Proxy-Authorization|Authorization|Cookie|Set-Cookie)\s*:/i;

function endQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === quote) return i;
  }
  return -1;
}

function quoted(line: string, state: Redaction): string {
  const start = QUOTED.exec(line);
  if (!start) return line;
  const quote = start[2]!;
  const end = endQuote(line, start.index + start[0].length, quote);
  const prefix = line.slice(0, start.index) + start[1] + HIDDEN;
  if (end < 0) {
    state.quote = quote;
    return prefix;
  }
  return prefix + quoted(line.slice(end + 1), state);
}

function continuedQuote(line: string, state: Redaction): string {
  const end = endQuote(line, 0, state.quote!);
  if (end < 0) return HIDDEN;
  state.quote = null;
  return HIDDEN + quoted(line.slice(end + 1), state);
}

function secretLine(line: string, state: Redaction): string {
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) state.privateKey = true;
  if (state.privateKey) {
    if (/-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) state.privateKey = false;
    return HIDDEN;
  }
  if (state.quote) return continuedQuote(line, state);
  if (state.header && /^[ \t]/.test(line)) return HIDDEN;
  state.header = HEADER.test(line);
  return quoted(line, state);
}

/* Move a byte cut to the next character boundary rather than creating a replacement character. */
function byteTail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(0, bytes.length - NODE_LOG_BYTES);
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function cleanLog(text: string, secrets: string[], state: Redaction): string {
  const plain = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  let clean = redact(plain, secrets).replace(/\r\n?/g, '\n').split('\n').map(line => secretLine(line, state)).join('\n');
  for (const [pattern, replacement] of CREDENTIALS) clean = clean.replace(pattern, replacement);
  const lines = clean.replace(/(?:\[hidden\]\n)+\[hidden\]/g, HIDDEN).split('\n').slice(-NODE_LOG_LINES).join('\n');
  return byteTail(lines);
}

export const nodeLog = (text: string, secrets: string[]): string => cleanLog(text, secrets, redaction());

/* Credentials may span callbacks. Keep their context until a closing quote/key marker or unfolded header arrives. */
export function nodeLogStream(): (text: string, secrets: string[]) => string {
  const state = redaction();
  return (text, secrets) => cleanLog(text, secrets, state);
}
