/* What may leave a node in a task checkpoint. It cannot prove arbitrary text free of secrets, so it withholds what it cannot
   tell: a doubtful line goes whole, never partly masked, and what it cannot read at all stays in the source workspace. */
export const SANITIZER_VERSION = 'handoff-redaction/1';
export const REDACTED = '[redacted]';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_CONTEXT_BYTES = 64 * 1024;

const MAX_RECORD_CHARS = 16 * 1024;
const MIN_CUT_PIECE = 6;
const MAX_PASSES = 8;
const MAX_DECODED_SPANS = 16;
const CUT_NOTICE = '[cut: older records left out]\n';

/* Every form a secret may show in. Unlike redact.ts this keeps short values: a checkpoint hides too much rather than too little. */
function knownForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    const bytes = Buffer.from(secret), base64 = bytes.toString('base64'), hex = bytes.toString('hex');
    for (const form of [secret, base64, base64.replace(/=+$/, ''), bytes.toString('base64url'), hex, hex.toUpperCase(), encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) forms.add(form);
  }
  return [...forms];
}
const holdsForm = (text: string, forms: readonly string[]) => forms.some(form => text.includes(form));

const TOKEN_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{8,}/, /github_pat_[A-Za-z0-9_]{8,}/, /\bsk-[A-Za-z0-9_-]{8,}/, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/,
  /xox[abeoprs]-[A-Za-z0-9-]{8,}/, /xapp-[A-Za-z0-9-]{8,}/, /(?:AKIA|ASIA)[0-9A-Z]{12,}/, /AIza[0-9A-Za-z_-]{16,}/, /glpat-[A-Za-z0-9_-]{8,}/,
  /\bnpm_[A-Za-z0-9]{16,}/, /pypi-[A-Za-z0-9_-]{16,}/, /\bhf_[A-Za-z0-9]{16,}/, /\bSG\.[A-Za-z0-9_-]{16,}/, /ya29\.[A-Za-z0-9_-]{16,}/, /whsec_[A-Za-z0-9]{8,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
];
const CREDENTIAL_SHAPES = [
  /\b(?:proxy-)?authorization\s*[:=]/i, /\bbearer\s+[^\s"'`]{8,}/i, /\b(?:set-)?cookie\s*[:=]/i, /\bx-api-key\s*[:=]/i,
  /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@'"`]+@/i,
];
const holdsToken = (text: string) => TOKEN_SHAPES.some(shape => shape.test(text));

function holdsBasicAuth(text: string): boolean {
  const found = /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})/i.exec(text);
  return found !== null && Buffer.from(found[1]!, 'base64').includes(':');
}

const SENSITIVE_NAME = /pass(?:word|wd|phrase)|\bpwd\b|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key|private[_-]?key|credential|^HH_/i;
const PASSWORD_NAME = /pass|pwd/i;
const ASSIGNMENT = /(?<![=!<>:])(?::=|=(?![=>])|:(?![:/=]))/g;
const NAME_BEFORE = /([A-Za-z0-9_.$-]+)\??["'`\]]?\s*$/;
const MAX_VALUE_CHARS = 256;
/* Code that holds no value: an open block, a type, a property or a call without a literal in it. */
const NO_VALUE = [
  /^$/, /^[[{(]$/,
  /^(?:string|number|boolean|bigint|null|undefined|unknown|any|void|never|none|nil|true|false)\b[^'"`]*$/,
  /^(?:await\s+|new\s+)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:<[^'"`]*>)?\([^'"`]*$/,
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+[\s,;)\]}]*$/,
  /^(?:async\s+)?\([^'"`]*\)\s*=>[^'"`]*$/,
];

function holdsNoValue(name: string, value: string): boolean {
  if (value.length > MAX_VALUE_CHARS) return false;
  const bare = value.replace(/[\s,;)\]}]+$/, '');
  if (bare === name) return true;
  if (/^\d{1,6}$/.test(bare) && !PASSWORD_NAME.test(name)) return true;
  return NO_VALUE.some(shape => shape.test(value));
}
function holdsSecretAssignment(record: string): boolean {
  for (const found of record.matchAll(ASSIGNMENT)) {
    const name = NAME_BEFORE.exec(record.slice(Math.max(0, found.index - 64), found.index))?.[1];
    if (!name || !SENSITIVE_NAME.test(name)) continue;
    if (!holdsNoValue(name, record.slice(found.index + found[0].length).trim())) return true;
  }
  return false;
}

const OPAQUE_SPAN = /[A-Za-z0-9+/=_-]{32,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LOCKFILE_DIGEST = /sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}
function looksRandom(span: string): boolean {
  const bits = entropy(span);
  if (/^[0-9a-fA-F]+$/.test(span)) return bits >= 3;
  if (/\d/.test(span)) return bits >= 4.2;
  return bits >= 4.5 && /[A-Z]/.test(span) && /[a-z]/.test(span);
}
/* A UUID names something and a lockfile's digest checks a package; neither lets anyone in. */
function holdsOpaqueSpan(record: string): boolean {
  let text = record.replace(UUID, ' ');
  if (/\bintegrity\b/i.test(text)) text = text.replace(LOCKFILE_DIGEST, ' ');
  return (text.match(OPAQUE_SPAN) ?? []).some(looksRandom);
}

function decodeEscapes(record: string): string {
  return record.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_all, four?: string, two?: string) => String.fromCharCode(parseInt(four ?? two!, 16)));
}
function decodePercent(record: string): string {
  return record.replace(/%([0-9a-fA-F]{2})/g, (_all, two: string) => String.fromCharCode(parseInt(two, 16)));
}
const holdsSecretShape = (view: string) => holdsToken(view) || CREDENTIAL_SHAPES.some(shape => shape.test(view)) || holdsBasicAuth(view) || holdsSecretAssignment(view) || holdsOpaqueSpan(view);

const isPrintable = (text: string) => /^[\x20-\x7e\t\r\n]*$/.test(text);
const decodedHolds = (decoded: string, forms: readonly string[]): boolean =>
  isPrintable(decoded) && (holdsForm(decoded, forms) || holdsToken(decoded) || CREDENTIAL_SHAPES.some(shape => shape.test(decoded)));
/* What a span says once decoded, one level deep and only for so many spans, so no record costs unbounded work. */
function decodedSpansHold(record: string, forms: readonly string[]): boolean {
  const spans = record.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [];
  for (const span of spans.slice(0, MAX_DECODED_SPANS)) {
    const encodings: BufferEncoding[] = /^[0-9a-fA-F]+$/.test(span) ? ['hex', 'base64'] : ['base64'];
    for (const encoding of encodings) {
      if (decodedHolds(Buffer.from(span, encoding).toString('latin1'), forms)) return true;
    }
  }
  return false;
}

/* Invisible, control and private characters can hide what a line says, so such a line is doubtful whatever else it holds. */
const OBFUSCATION = /(?!\t)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}�]/u;

function recordIsDoubtful(record: string, forms: readonly string[]): boolean {
  if (record === REDACTED) return false;
  if (record.length > MAX_RECORD_CHARS || OBFUSCATION.test(record)) return true;
  const views = new Set([record, record.normalize('NFKC'), decodeEscapes(record), decodePercent(record)]);
  for (const view of views) if (holdsForm(view, forms) || holdsSecretShape(view)) return true;
  const glued = record.replace(/["'`+\s]/g, '');
  return holdsForm(glued, forms) || holdsToken(glued) || decodedSpansHold(record, forms);
}

interface Records { bodies: string[]; endings: string[] }
function splitRecords(text: string): Records {
  const parts = text.split('\n'), bodies: string[] = [], endings: string[] = [];
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (last && part === '') return;
    const crlf = !last && part.endsWith('\r');
    bodies.push(crlf ? part.slice(0, -1) : part);
    endings.push(last ? '' : crlf ? '\r\n' : '\n');
  });
  return { bodies, endings };
}

const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const quotedWords = (body: string): string => (body.match(QUOTED) ?? []).map(quoted => decodeEscapes(quoted.slice(1, -1))).join('');
/* What a line may say of a secret, and what between the pieces of it is not part of it: line breaks, concatenation, a comment, a variable's name. */
const LINE_VIEWS: readonly ((body: string) => string)[] = [body => body, body => body.normalize('NFKC'), decodeEscapes, decodePercent, quotedWords];
const BETWEEN_PIECES = [/\s+/g, /[^\p{L}\p{N}]+/gu];

function lineHolding(starts: readonly number[], offset: number): number {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
function markLinesSpanned(parts: readonly string[], joined: string, target: string, marked: Set<number>): void {
  const starts: number[] = [];
  let length = 0;
  for (const part of parts) { starts.push(length); length += part.length; }
  for (let at = joined.indexOf(target); at !== -1; at = joined.indexOf(target, at + 1)) {
    const last = lineHolding(starts, at + target.length - 1);
    for (let line = lineHolding(starts, at); line <= last; line++) if (parts[line]) marked.add(line);
  }
}
/* Lines a known secret of any length runs across in some view. A redaction or a line too long to judge says nothing: it goes anyway. */
function linesSplittingASecret(bodies: readonly string[], forms: readonly string[]): Set<number> {
  const marked = new Set<number>(), seen = new Set<string>();
  if (!forms.length) return marked;
  const judged = bodies.map(body => (body === REDACTED || body.length > MAX_RECORD_CHARS ? '' : body));
  for (const view of LINE_VIEWS) {
    const viewed = judged.map(view);
    for (const between of BETWEEN_PIECES) {
      const parts = viewed.map(part => part.replace(between, '')), joined = parts.join('');
      if (seen.has(joined)) continue;
      seen.add(joined);
      for (const target of new Set(forms.map(form => form.replace(between, '')))) if (target) markLinesSpanned(parts, joined, target, marked);
    }
  }
  return marked;
}
function holdsCutPiece(form: string, edge: string, fits: (piece: string) => boolean, piece: (size: number) => string): boolean {
  for (let size = Math.min(form.length - 1, edge.length); size >= MIN_CUT_PIECE; size--) if (fits(piece(size))) return true;
  return false;
}
/* A text cut by a limit can begin or end in the middle of a secret, too short a piece for any other rule to know. */
function linesCutThroughASecret(bodies: readonly string[], forms: readonly string[]): Set<number> {
  const marked = new Set<number>();
  if (!bodies.length) return marked;
  const first = bodies[0]!, end = bodies.length - 1, last = bodies[end]!;
  for (const form of forms) {
    if (holdsCutPiece(form, first, piece => first.startsWith(piece), size => form.slice(-size))) marked.add(0);
    if (holdsCutPiece(form, last, piece => last.endsWith(piece), size => form.slice(0, size))) marked.add(end);
  }
  return marked;
}

const PEM_BEGIN = /-{5}BEGIN [A-Z0-9 ]+-{5}/;
const PEM_END = /-{5}END [A-Z0-9 ]+-{5}/;
/* A block is one record: where it ends, or the end of the text when the block was cut. */
function pemBlockEnd(bodies: readonly string[], start: number): number | null {
  if (!PEM_BEGIN.test(bodies[start]!)) return null;
  for (let line = start; line < bodies.length; line++) if (PEM_END.test(bodies[line]!)) return line;
  return bodies.length - 1;
}

export interface SanitizedText { text: string; redactedRecords: number }
function cleanOnce(text: string, forms: readonly string[]): SanitizedText {
  const { bodies, endings } = splitRecords(text);
  const marked = new Set([...linesSplittingASecret(bodies, forms), ...linesCutThroughASecret(bodies, forms)]);
  const out: string[] = [];
  let redactedRecords = 0;
  for (let line = 0; line < bodies.length; line++) {
    const end = pemBlockEnd(bodies, line) ?? line;
    if (end !== line || marked.has(line) || PEM_BEGIN.test(bodies[line]!) || recordIsDoubtful(bodies[line]!, forms)) {
      out.push(REDACTED + endings[end]!);
      if (end !== line || bodies[line] !== REDACTED) redactedRecords++;
      line = end;
    } else out.push(bodies[line]! + endings[line]!);
  }
  return { text: out.join(''), redactedRecords };
}
/* A line gone can bring two others together, so cleaning repeats until it finds nothing. A chain too long to follow leaves nothing to judge. */
export function sanitizeText(text: string, secrets: readonly string[]): SanitizedText {
  const forms = knownForms(secrets);
  let current = text, redactedRecords = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const once = cleanOnce(current, forms);
    if (!once.redactedRecords) return { text: current, redactedRecords };
    current = once.text;
    redactedRecords += once.redactedRecords;
  }
  const { bodies, endings } = splitRecords(current);
  return { text: bodies.map((_, line) => REDACTED + endings[line]!).join(''), redactedRecords: redactedRecords + bodies.length };
}

/* The second pass: text that sanitizing would still change has not been sanitized. */
export function isSanitized(text: string, secrets: readonly string[]): boolean {
  return sanitizeText(text, secrets).text === text;
}

export type OmitReason = 'binary' | 'lfs' | 'too_large';
export type SanitizedContent = { status: 'clean' | 'redacted'; bytes: Buffer; redactedRecords: number } | { status: 'omitted'; reason: OmitReason };

function decodeUtf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
export function sanitizeContent(bytes: Buffer, secrets: readonly string[]): SanitizedContent {
  if (bytes.length > MAX_FILE_BYTES) return { status: 'omitted', reason: 'too_large' };
  const text = decodeUtf8(bytes);
  if (text === null || text.includes('\0')) return { status: 'omitted', reason: 'binary' };
  if (text.startsWith('version https://git-lfs.github.com/spec/')) return { status: 'omitted', reason: 'lfs' };
  const out = sanitizeText(text, secrets);
  return out.redactedRecords ? { status: 'redacted', bytes: Buffer.from(out.text), redactedRecords: out.redactedRecords } : { status: 'clean', bytes, redactedRecords: 0 };
}

export function sanitizePath(path: string, secrets: readonly string[]): { path: string; clean: boolean } {
  const clean = !path.includes('\n') && sanitizeText(path, secrets).redactedRecords === 0;
  return clean ? { path, clean } : { path: REDACTED, clean };
}

const SENSITIVE_FOLDERS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.gcloud', '.azure', '.kube', '.docker', '.claude', '.codex', '.kimi', '.gemini', '.antigravity']);
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|(?:credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini|env|txt|conf|cfg))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx))$/;
const ARTIFACT_FOLDERS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'coverage', '.next', '.nuxt', '.turbo', 'target', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.parcel-cache', 'test-results', 'playwright-report']);

export type PathClass = 'task' | 'artifact' | 'sensitive';
/* By name alone: a credential store never leaves, and generated output is not the task's work. */
export function classifyPath(path: string): PathClass {
  const parts = path.toLowerCase().split('/');
  if (parts.some(part => SENSITIVE_FOLDERS.has(part) || SENSITIVE_NAMES.test(part))) return 'sensitive';
  return parts.slice(0, -1).some(part => ARTIFACT_FOLDERS.has(part)) ? 'artifact' : 'task';
}

/* A context file: cleaned first, then cut from its old end at whole records. A record too long for the limit is not cut, it goes. */
export function sanitizeContext(text: string | null, secrets: readonly string[], maxBytes = MAX_CONTEXT_BYTES): string {
  if (text === null) return sanitizeText('unavailable\n', secrets).text;
  const clean = sanitizeText(text, secrets).text;
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  const lines = clean.split('\n'), kept: string[] = [];
  let room = maxBytes - Buffer.byteLength(CUT_NOTICE);
  for (let line = lines.length - 1; line >= 0; line--) {
    room -= Buffer.byteLength(lines[line]!) + 1;
    if (room < 0) break;
    kept.unshift(lines[line]!);
  }
  return kept.length ? sanitizeText(CUT_NOTICE + kept.join('\n'), secrets).text : REDACTED;
}
