/* What may reach a program from its terminal. Words, a paste and Enter are a message. Keys that steer the program, and a line
   that starts with / or ! for it to run, come only from the owner of its plan. The browser says the same to be polite; this
   decides, on what the frame holds and not on anything it claims. */
export type InputRights = { control: boolean; message: boolean };
export type InputRefusal = 'control' | 'message';

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
/* Enter and the keys that erase write nothing into the program. In a paste, Enter is all that may stand among the words. */
const STEERS = /[\x00-\x07\x09\x0b\x0c\x0e-\x1f]/;
const STEERS_IN_PASTE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;
/* Focus, the answers to a program's queries and the mouse are no keys a person typed. */
const REPORT = /^\x1b\[(?:[IO]|[>?][0-9;]*c|[0-9;]*R|<[0-9]+;[0-9]+;[0-9]+[Mm])$/;
/* How long a line counts as holding words with no key from anyone: a program may have taken them by then. */
const LINE_MS = 30_000;

export const isReport = (data: string): boolean => REPORT.test(data);

const newLine = (key: string) => key === '\r' || key === '\n';
const erases = (key: string) => key === '\b' || key === '\x7f';

/* The input line of one agent's program as its terminals made it, for all of them. It starts empty, and what cannot be known
   counts as empty: that is where / and ! are refused. */
export class InputLine {
  private length = 0;
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
    this.length = 0;
    this.blocked = false;
  }

  private forgetOld(): void {
    if (Date.now() - this.at >= LINE_MS) this.empty();
    this.at = Date.now();
  }

  /* An owner's key that steers may do anything to the line. */
  private ofOwner(data: string): void {
    this.blocked = false;
    const text = PASTE.exec(data)?.[1] ?? data;
    if (STEERS.test(text)) this.length = 0;
    else this.length = lengthAfter(this.length, text) ?? this.length + text.length;
  }

  private ofMessage(data: string): InputRefusal | null {
    const paste = PASTE.exec(data);
    const text = paste?.[1] ?? data;
    if ((paste ? STEERS_IN_PASTE : STEERS).test(text)) return 'control';
    if (this.blocked) return this.afterCommand(text);
    const length = lengthAfter(this.length, text);
    if (length === null) {
      /* The rest of a command typed key by key is that command too, up to its Enter. */
      this.blocked = this.length === 0 && /^[/!]/.test(text) && !/[\r\n]/.test(text);
      return 'control';
    }
    this.length = length;
    return null;
  }

  private afterCommand(text: string): InputRefusal | null {
    if (!/[\r\n]/.test(text)) return 'control';
    this.empty();
    return [...text].every(newLine) ? null : 'control';
  }
}

/* How long the line gets with these keys, or null when one of them starts a line with what runs a command. */
function lengthAfter(from: number, text: string): number | null {
  let length = from;
  for (const key of text) {
    if (newLine(key)) length = 0;
    else if (erases(key)) length = Math.max(0, length - 1);
    else if (length === 0 && (key === '/' || key === '!')) return null;
    else length++;
  }
  return length;
}
