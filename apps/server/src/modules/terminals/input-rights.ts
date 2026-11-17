/* What may reach a program from its terminal. Words, a paste and Enter are a message. Keys that steer the program, and a line
   that starts with / or ! for it to run, come only from the owner of its plan. The browser says the same to be polite; this
   decides, on what the frame holds and not on anything it claims. */
type InputRights = { control: boolean; message: boolean };
export type InputRefusal = 'control' | 'message';

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
/* Enter and the keys that erase write nothing into the program. In a paste, Enter is all that may stand among the words. */
const STEERS = /[\x00-\x07\x09\x0b\x0c\x0e-\x1f\x80-\x9f]/;
const STEERS_IN_PASTE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
/* How long a line counts as holding words with no key from anyone: a program may have taken them by then. */
const LINE_MS = 30_000;

const newLine = (key: string) => key === '\r' || key === '\n';
/* How much is surely on the line: never more than a program holds, so that no line counts as holding words once it may be empty.
   Sure until an erase may take more than one key with it. */
type Line = { length: number; sure: boolean };
const EMPTY: Line = { length: 0, sure: true };

/* Marks, joiners and whatever this Unicode does not know yet may be left out of a line by a program. */
const SHOWS = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const pieces = (text: string) => [...graphemes.segment(text)].length;
/* A key no program takes for one character together with the key before or after it. */
const standsAlone = (key: string) => /^[ -~]$/.test(key) || (pieces(`a${key}a`) === 3 && pieces(`${key}${key}`) === 2);

/* The input line of one agent's program as its terminals made it, for all of them. It starts empty, and what cannot be known
   counts as empty: that is where / and ! are refused. */
export class InputLine {
  private line = EMPTY;
  private blocked = false;
  private at = 0;

  /* Why these keys do not go on, or null once they may, and the line then holds them. */
  take(data: string, rights: InputRights): InputRefusal | null {
    this.forgetOld();
    if (rights.control) {
      this.ofOwner(data);
      return null;
    }
    return rights.message ? this.ofMessage(data) : 'message';
  }

  empty(): void {
    this.line = EMPTY;
    this.blocked = false;
  }

  private forgetOld(): void {
    if (Date.now() - this.at >= LINE_MS) this.empty();
    this.at = Date.now();
  }

  /* An owner's key that steers may do anything to the line. */
  private ofOwner(data: string): void {
    this.blocked = false;
    const paste = PASTE.exec(data);
    const text = paste?.[1] ?? data;
    this.line = STEERS.test(text) ? EMPTY : lineAfter(this.line, text, Boolean(paste), false)!;
  }

  private ofMessage(data: string): InputRefusal | null {
    const paste = PASTE.exec(data);
    const text = paste?.[1] ?? data;
    if ((paste ? STEERS_IN_PASTE : STEERS).test(text)) return 'control';
    if (this.blocked) return this.afterCommand(text);
    const line = lineAfter(this.line, text, Boolean(paste), true);
    if (line === null) {
      /* The rest of a command typed key by key is that command too, up to its Enter. */
      this.blocked = this.line.length === 0 && /^\s*[/!]/.test(text) && !/[\r\n]/.test(text);
      return 'control';
    }
    this.line = line;
    return null;
  }

  private afterCommand(text: string): InputRefusal | null {
    if (!/[\r\n]/.test(text)) return 'control';
    this.empty();
    return [...text].every(newLine) ? null : 'control';
  }
}

/* An erase after several keys of one frame or a paste comes to the same: a program may have taken them for one. */
const cleared = (whole: boolean): Line => ({ length: 0, sure: !whole });

function withKey(line: Line, key: string): Line {
  const counts = SHOWS.test(key) || (line.length > 0 && !key.trim());
  return { length: line.length + (counts ? 1 : 0), sure: line.sure && standsAlone(key) };
}

/* The line after these keys, or null when one of them starts a line with what runs a command, for someone who may not. Spaces do
   not start a line: a program may trim them before it looks for a command. Programs differ in what one erase takes: a letter with
   its accent, a whole paste that shows as one, a word for the \b of Ctrl+Backspace. So only what stands alone and came key by key
   is counted down; after anything else an erase leaves the line counted as empty. */
function lineAfter(from: Line, text: string, pasted: boolean, refusing: boolean): Line | null {
  const keys = [...text], whole = pasted || keys.length > 1;
  let line = whole ? { ...from, sure: false } : from;
  for (const key of keys) {
    const next = lineAfterKey(line, key, whole, refusing);
    if (next === null) return null;
    line = next;
  }
  return line;
}

function lineAfterKey(line: Line, key: string, whole: boolean, refusing: boolean): Line | null {
  if (newLine(key)) return cleared(whole);
  if (key === '\x7f' || key === '\b') return afterErase(line, key, whole);
  if (refusing && startsCommand(line, key)) return null;
  return withKey(line, key);
}

function afterErase(line: Line, key: string, whole: boolean): Line {
  if (key === '\x7f' && line.sure) return { ...line, length: Math.max(0, line.length - 1) };
  return cleared(whole);
}

function startsCommand(line: Line, key: string): boolean {
  return line.length === 0 && (key === '/' || key === '!');
}
