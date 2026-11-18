import { fileURLToPath } from 'node:url';
import { HIDDEN, MIN_SECRET_LENGTH, secretForms } from '@hornhoof/protocol/redaction';
import type { ResvgRenderOptions } from '@resvg/resvg-js';
import { PAINTER_DEADLINE_MS, ScreenPainter, startPainterWorker } from './painter.js';

type OperatorScreenInput = {
  cells: string;
  cols: number;
  rows: number;
  secrets: string[];
};

type OperatorScreenResult = {
  png: Buffer;
  text: string;
  width: number;
  height: number;
};

type OperatorScreenSvgResult = {
  svg: string;
  text: string;
  width: number;
  height: number;
};

type Style = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
};

type Glyph = {
  ch: string;
  style: Style;
};

type Token = Glyph | '\n';

const MAX_CELLS_BYTES = 65_536;
const MAX_PNG_BYTES = 1_048_576;
const MAX_COLS = 512;
const MAX_ROWS = 256;
const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
const BASELINE = 14;
const PADDING = 12;
const TAB_WIDTH = 8;
const DEFAULT_BG = '#0f1419';
const DEFAULT_FG = '#e6edf3';
const HIDDEN_GLYPHS = [...HIDDEN];
const FONT_FAMILY = 'DejaVu Sans Mono';
const FONT_FILES = [
  fileURLToPath(new URL('./fonts/DejaVuSansMono.ttf', import.meta.url)),
  fileURLToPath(new URL('./fonts/DejaVuSansMono-Bold.ttf', import.meta.url)),
];
/* How resvg draws a screen's SVG: only with the fonts that come with the server, wherever it runs. */
export const PAINT_OPTIONS: ResvgRenderOptions = {
  font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY, monospaceFamily: FONT_FAMILY },
};
/* Draws an SVG into a PNG. */
export type Paint = (svg: string) => Promise<Uint8Array>;
const painter = new ScreenPainter(() => startPainterWorker(PAINT_OPTIONS), PAINTER_DEADLINE_MS);
const paintInWorker: Paint = svg => painter.paint(svg);

const PLAIN_STYLE: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  underline: false,
  inverse: false,
};

const ANSI_16 = [
  '#1f242c', '#f85149', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#d0d7de',
  '#6e7681', '#ff7b72', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff',
] as const;

const SGR_TOKEN = /\x1b\[([0-9;:]*)m/g;

function buildSimpleSgr(): Map<number, Partial<Style>> {
  const map = new Map<number, Partial<Style>>([
    [0, PLAIN_STYLE],
    [1, { bold: true }],
    [2, { dim: true }],
    [4, { underline: true }],
    [7, { inverse: true }],
    [21, { bold: false, dim: false }],
    [22, { bold: false, dim: false }],
    [24, { underline: false }],
    [27, { inverse: false }],
    [39, { fg: null }],
    [49, { bg: null }],
  ]);
  for (let i = 0; i < 8; i++) {
    map.set(30 + i, { fg: ANSI_16[i]! });
    map.set(40 + i, { bg: ANSI_16[i]! });
    map.set(90 + i, { fg: ANSI_16[8 + i]! });
    map.set(100 + i, { bg: ANSI_16[8 + i]! });
  }
  return map;
}

const SIMPLE_SGR = buildSimpleSgr();

function hexByte(n: number): string {
  return Math.min(255, n).toString(16).padStart(2, '0');
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

function ansi256Hex(index: number): string | null {
  if (index > 255) return null;
  if (index < 16) return ANSI_16[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbHex(level, level, level);
  }
  const cube = index - 16;
  const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return rgbHex(step(Math.trunc(cube / 36)), step(Math.trunc(cube / 6) % 6), step(cube % 6));
}

function colorFromArgs(args: number[]): string | null {
  if (args[0] === 5 && args.length >= 2) return ansi256Hex(args[1]!);
  if (args[0] !== 2) return null;
  const offset = args.length >= 5 ? 2 : 1;
  return args.length >= offset + 3 ? rgbHex(args[offset]!, args[offset + 1]!, args[offset + 2]!) : null;
}

function setChannel(state: Style, head: number, color: string | null): void {
  if (!color) return;
  if (head === 38) state.fg = color;
  else state.bg = color;
}

function applyExtendedColor(state: Style, parts: string[], index: number): number {
  const raw = parts[index]!;
  const head = Number(raw.split(':')[0]);
  if (raw.includes(':')) {
    setChannel(state, head, colorFromArgs(raw.split(':').slice(1).map(Number)));
    return 1;
  }
  const mode = Number(parts[index + 1]);
  const step = mode === 5 ? 3 : mode === 2 ? 5 : 1;
  if (step > 1 && index + step <= parts.length) {
    setChannel(state, head, colorFromArgs(parts.slice(index + 1, index + step).map(Number)));
  }
  return step;
}

function applySgr(state: Style, spec: string): void {
  const parts = spec.split(';');
  for (let i = 0; i < parts.length; ) {
    const token = parts[i]!;
    const head = Number(token.split(':')[0]);
    if (head === 38 || head === 48) {
      i += applyExtendedColor(state, parts, i);
    } else {
      const patch = SIMPLE_SGR.get(head);
      if (patch) Object.assign(state, patch);
      i++;
    }
  }
}

/* Removes DCS/OSC payloads, links, clipboard writes, cursor controls, and XML-illegal code points while keeping SGR. */
function stripControls(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|\x07|$)/g, '')
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)(?![0-9;:]*m)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*$/g, '')
    .replace(/\x1b(?!\[[0-9;:]*m)[ -/]*[@-~]?/g, '')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, '')
    .replace(/[\ud800-\udfff\ufffe\uffff]/g, '\ufffd');
}

function appendTextRun(target: Glyph[], segment: string, style: Style): void {
  const snapshot: Style = { ...style };
  for (const ch of segment) {
    if (ch === '\t') {
      const spaces = TAB_WIDTH - (target.length % TAB_WIDTH);
      for (let i = 0; i < spaces; i++) target.push({ ch: ' ', style: snapshot });
    } else {
      target.push({ ch, style: snapshot });
    }
  }
}

function parseTokens(cleaned: string): Token[] {
  const trimmed = cleaned.endsWith('\n') ? cleaned.slice(0, -1) : cleaned;
  const rawLines = trimmed.split('\n');
  const style: Style = { ...PLAIN_STYLE };
  const tokens: Token[] = [];
  rawLines.forEach((line, lineIdx) => {
    if (lineIdx > 0) tokens.push('\n');
    const glyphs: Glyph[] = [];
    let last = 0;
    SGR_TOKEN.lastIndex = 0;
    for (let match = SGR_TOKEN.exec(line); match !== null; match = SGR_TOKEN.exec(line)) {
      if (match.index > last) appendTextRun(glyphs, line.slice(last, match.index), style);
      applySgr(style, match[1]!);
      last = match.index + match[0].length;
    }
    if (last < line.length) appendTextRun(glyphs, line.slice(last), style);
    tokens.push(...glyphs);
  });
  return tokens;
}

function matchSpan(tokens: Token[], start: number, needle: string[], allowWrap: boolean): number {
  if (tokens[start] === '\n') return 0;
  let pos = start;
  let matched = 0;
  while (pos < tokens.length && matched < needle.length) {
    const tok = tokens[pos]!;
    if (tok === '\n') {
      if (!allowWrap) return 0;
      pos++;
    } else if (tok.ch === needle[matched]) {
      pos++;
      matched++;
    } else {
      return 0;
    }
  }
  return matched === needle.length ? pos - start : 0;
}

function maskTokens(tokens: Token[], forms: string[][]): Token[] {
  let current = tokens;
  for (const needle of forms) {
    const next: Token[] = [];
    const keepMask = HIDDEN.includes(needle.join(''));
    for (let i = 0; i < current.length; ) {
      if (keepMask && matchSpan(current, i, HIDDEN_GLYPHS, false)) {
        next.push(...current.slice(i, i + HIDDEN_GLYPHS.length));
        i += HIDDEN_GLYPHS.length;
        continue;
      }
      const span = matchSpan(current, i, needle, needle.length >= MIN_SECRET_LENGTH);
      if (span > 0) {
        for (const ch of HIDDEN) next.push({ ch, style: { ...PLAIN_STYLE } });
        i += span;
      } else {
        next.push(current[i]!);
        i++;
      }
    }
    current = next;
  }
  return current;
}

function splitLines(tokens: Token[]): Glyph[][] {
  const lines: Glyph[][] = [[]];
  for (const tok of tokens) {
    if (tok === '\n') lines.push([]);
    else lines[lines.length - 1]!.push(tok);
  }
  return lines;
}

function plainTextOf(lines: Glyph[][]): string {
  return lines
    .map(line => line.map(g => g.ch).join('').replace(/ +$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
}

function wrapGrid(lines: Glyph[][], cols: number, rows: number): Glyph[][] {
  const wrapped: Glyph[][] = [];
  for (const line of lines) {
    if (line.length === 0) {
      wrapped.push([]);
      continue;
    }
    for (let offset = 0; offset < line.length; offset += cols) {
      wrapped.push(line.slice(offset, offset + cols));
    }
  }
  return wrapped.slice(0, rows);
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cellColors(style: Style): { fg: string; bg: string } {
  const rawFg = style.fg ?? DEFAULT_FG;
  const rawBg = style.bg ?? DEFAULT_BG;
  return style.inverse ? { fg: rawBg, bg: rawFg } : { fg: rawFg, bg: rawBg };
}

function renderRowSvg(row: Glyph[], rowIndex: number): { rects: string[]; texts: string[] } {
  const rects: string[] = [];
  const texts: string[] = [];
  const y = PADDING + rowIndex * CELL_HEIGHT;
  for (let col = 0; col < row.length; col++) {
    const cell = row[col]!;
    const x = PADDING + col * CELL_WIDTH;
    const { fg, bg } = cellColors(cell.style);
    if (bg !== DEFAULT_BG) {
      rects.push(`<rect x="${x}" y="${y}" width="${CELL_WIDTH}" height="${CELL_HEIGHT}" fill="${bg}"/>`);
    }
    if (cell.style.underline) {
      rects.push(`<rect x="${x}" y="${y + CELL_HEIGHT - 2}" width="${CELL_WIDTH}" height="1" fill="${fg}"/>`);
    }
    if (cell.ch !== ' ') {
      const weight = cell.style.bold ? ' font-weight="700"' : '';
      const opacity = cell.style.dim ? ' fill-opacity="0.65"' : '';
      texts.push(`<text x="${x}" y="${y + BASELINE}" fill="${fg}"${weight}${opacity}>${escapeXml(cell.ch)}</text>`);
    }
  }
  return { rects, texts };
}

function validateInput(input: OperatorScreenInput): void {
  const okCols = Number.isInteger(input.cols) && input.cols >= 1 && input.cols <= MAX_COLS;
  const okRows = Number.isInteger(input.rows) && input.rows >= 1 && input.rows <= MAX_ROWS;
  if (!okCols || !okRows) {
    throw new RangeError('Operator screen dimensions are out of bounds.');
  }
  if (Buffer.byteLength(input.cells, 'utf8') > MAX_CELLS_BYTES) {
    throw new RangeError('Operator screen cells exceed 64 KiB.');
  }
}

export function renderOperatorScreenSvg(input: OperatorScreenInput): OperatorScreenSvgResult {
  validateInput(input);
  const forms = secretForms(input.secrets.map(value => value.normalize('NFC')), 'literal').map(value => [...value]);
  const lines = splitLines(maskTokens(parseTokens(stripControls(input.cells)), forms));
  const text = plainTextOf(lines);
  const grid = wrapGrid(lines, input.cols, input.rows);
  const width = PADDING * 2 + input.cols * CELL_WIDTH;
  const height = PADDING * 2 + input.rows * CELL_HEIGHT;

  const rects: string[] = [`<rect width="${width}" height="${height}" fill="${DEFAULT_BG}"/>`];
  const texts: string[] = [];
  for (let r = 0; r < grid.length; r++) {
    const rowOut = renderRowSvg(grid[r]!, r);
    rects.push(...rowOut.rects);
    texts.push(...rowOut.texts);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...rects,
    `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" xml:space="preserve">`,
    ...texts,
    '</g>',
    '</svg>',
  ].join('');

  return { svg, text, width, height };
}

/* The SVG is made here; the PNG is drawn in the painter's thread, as a dense pane takes resvg seconds. A failed or stuck drawing
   rejects with a PainterError. */
export async function renderOperatorScreen(input: OperatorScreenInput, paint: Paint = paintInWorker): Promise<OperatorScreenResult> {
  const { svg, text, width, height } = renderOperatorScreenSvg(input);
  const drawn = await paint(svg);
  const png = Buffer.from(drawn.buffer, drawn.byteOffset, drawn.byteLength);
  if (png.byteLength > MAX_PNG_BYTES) {
    throw new RangeError('Operator screen PNG exceeds 1 MiB.');
  }
  return { png, text, width, height };
}
