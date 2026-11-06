export type TerminalRights = { control: boolean; message: boolean };
export type InputRefusal = 'control' | 'message';

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const CONTROL = /[\x00-\x07\x09\x0b\x0c\x0e-\x1f]/;
const PASTE_CONTROL = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;

export const isBracketedPaste = (data: string): boolean => PASTE.test(data);

export class TerminalInput {
  private line = 0;
  private blocked = false;

  take(data: string, rights: TerminalRights): { data: string; denied?: InputRefusal } {
    if (rights.control) {
      this.blocked = false;
      return { data };
    }
    return this.message(data, rights.message);
  }

  private message(data: string, allowed: boolean): { data: string; denied?: InputRefusal } {
    if (!allowed) return { data: '', denied: 'message' };
    const paste = PASTE.exec(data);
    const text = paste?.[1] ?? data;
    if ((paste ? PASTE_CONTROL : CONTROL).test(text)) return { data: '', denied: 'control' };
    if (this.blocked) return this.afterBlocked(data, text);
    return this.acceptMessage(data, text);
  }

  private acceptMessage(data: string, text: string): { data: string; denied?: InputRefusal } {
    const line = this.after(text);
    if (line === null) {
      this.blocked = this.line === 0 && /^[/!]/.test(text) && !/[\r\n]/.test(text);
      return { data: '', denied: 'control' };
    }
    this.line = line;
    return { data };
  }

  private afterBlocked(data: string, text: string): { data: string; denied?: InputRefusal } {
    if (/^[\r\n]+$/.test(text)) {
      this.blocked = false;
      this.line = 0;
      return { data };
    }
    if (/[\r\n]/.test(text)) {
      this.blocked = false;
      this.line = 0;
    }
    return { data: '', denied: 'control' };
  }

  private after(text: string): number | null {
    let line = this.line;
    for (const key of text) {
      if (key === '\r' || key === '\n') line = 0;
      else if (key === '\b' || key === '\x7f') line = Math.max(0, line - 1);
      else {
        if (line === 0 && (key === '/' || key === '!')) return null;
        line++;
      }
    }
    return line;
  }
}
