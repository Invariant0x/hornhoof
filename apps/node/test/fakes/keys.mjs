// Keys as a program in raw mode reads them, for the fake programs. It asks the terminal for bracketed paste, as Claude Code,
// Codex and Kimi Code do, so a paste comes whole, its line breaks in it, however long it is. on(key) gets { text } for what
// was typed or pasted, or 'enter', 'escape' (also for another key's escape sequence), 'kill' (Ctrl+U) or 'erase'
// (Backspace). rawKeys() comes first, before the program shows where to type, as in the real programs; with ask: false it
// does not ask for bracketed paste yet, and bracketed() asks later, as a program does once its input box is up.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/* A lone Escape is a key; one followed at once by "[200~" starts a paste. */
const ESCAPE_WAIT_MS = 20;

const SINGLE = { '\r': 'enter', '\n': 'enter', '\x13': 'steer', '\x15': 'kill', '\x7f': 'erase', '\b': 'erase' };

export function rawKeys({ ask = true } = {}) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  if (ask) bracketed();
}

export function readKeys(on) {
  process.stdin.setEncoding('utf8');
  const keys = new Keys(on);
  process.stdin.on('data', data => keys.add(data));
}

/* What the terminal sent, read key by key as it comes: a paste waits for its end, and a lone Escape a moment for what may
   follow it. */
class Keys {
  rest = '';
  paste = null;
  timer = null;

  constructor(on) {
    this.on = on;
  }

  add(data) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rest += data;
    this.take();
  }

  take() {
    while (this.rest && this.next());
  }

  /* Reads what comes next; false when the rest has to wait for more. */
  next() {
    if (this.paste !== null) return this.pasted();
    if (this.rest.startsWith(PASTE_START)) return this.startPaste();
    /* The rest of a paste's start may still be on its way. */
    if (this.rest.length < PASTE_START.length && PASTE_START.startsWith(this.rest)) return this.waitForPaste();
    return this.key();
  }

  pasted() {
    const end = this.rest.indexOf(PASTE_END);
    if (end < 0) return this.pastedSoFar();
    this.paste += this.rest.slice(0, end);
    this.rest = this.rest.slice(end + PASTE_END.length);
    this.on({ text: this.paste.replace(/\r\n?/g, '\n') });
    this.paste = null;
    return true;
  }

  /* Keeps what may begin the paste's end marker for the next piece. */
  pastedSoFar() {
    const keep = partialEnd(this.rest);
    this.paste += this.rest.slice(0, this.rest.length - keep);
    this.rest = this.rest.slice(this.rest.length - keep);
    return false;
  }

  startPaste() {
    this.paste = '';
    this.rest = this.rest.slice(PASTE_START.length);
    return true;
  }

  waitForPaste() {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rest = this.rest.slice(1);
      this.on('escape');
      this.take();
    }, ESCAPE_WAIT_MS);
    return false;
  }

  /* Another key's escape sequence, such as an arrow's, counts as Escape. */
  key() {
    const sequence = this.rest.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)?.[0];
    const ch = sequence ?? String.fromCodePoint(this.rest.codePointAt(0));
    this.rest = this.rest.slice(ch.length);
    this.on(sequence || ch === '\x1b' ? 'escape' : (SINGLE[ch] ?? { text: ch }));
    return true;
  }
}

export function bracketed() {
  process.stdout.write('\x1b[?2004h');
}

/* How many characters at the end could begin the paste's end marker. */
function partialEnd(text) {
  for (let n = Math.min(PASTE_END.length - 1, text.length); n > 0; n--) if (PASTE_END.startsWith(text.slice(-n))) return n;
  return 0;
}
