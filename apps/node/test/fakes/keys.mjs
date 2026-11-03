// Keys as a program in raw mode reads them, for the fake programs. It asks the terminal for bracketed paste, as Claude Code,
// Codex and Kimi Code do, so a paste comes whole, its line breaks in it, however long it is. on(key) gets { text } for what
// was typed or pasted, or 'enter', 'escape' (also for another key's escape sequence), 'kill' (Ctrl+U) or 'erase'
// (Backspace). ask: false reads keys without asking
// for bracketed paste yet; bracketed() asks later, as a program does once its input box is up.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/* A lone Escape is a key; one followed at once by "[200~" starts a paste. */
const ESCAPE_WAIT_MS = 20;

const SINGLE = { '\r': 'enter', '\n': 'enter', '\x15': 'kill', '\x7f': 'erase', '\b': 'erase' };

export function readKeys(on, { ask = true } = {}) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  if (ask) bracketed();
  process.stdin.setEncoding('utf8');
  let rest = '';
  let paste = null;
  let timer = null;
  const take = () => {
    while (rest) {
      if (paste !== null) {
        const end = rest.indexOf(PASTE_END);
        const keep = end < 0 ? partialEnd(rest) : 0;
        paste += rest.slice(0, end < 0 ? rest.length - keep : end);
        rest = end < 0 ? rest.slice(rest.length - keep) : rest.slice(end + PASTE_END.length);
        if (end < 0) return;
        on({ text: paste.replace(/\r\n?/g, '\n') });
        paste = null;
        continue;
      }
      if (rest.startsWith(PASTE_START)) {
        paste = '';
        rest = rest.slice(PASTE_START.length);
        continue;
      }
      /* The rest of a paste's start may still be on its way. */
      if (rest.length < PASTE_START.length && PASTE_START.startsWith(rest)) {
        timer = setTimeout(() => {
          timer = null;
          rest = rest.slice(1);
          on('escape');
          take();
        }, ESCAPE_WAIT_MS);
        return;
      }
      /* Another key's escape sequence, such as an arrow's, counts as Escape. */
      const sequence = rest.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (sequence) {
        rest = rest.slice(sequence[0].length);
        on('escape');
        continue;
      }
      const ch = String.fromCodePoint(rest.codePointAt(0));
      rest = rest.slice(ch.length);
      if (ch === '\x1b') on('escape');
      else on(SINGLE[ch] ?? { text: ch });
    }
  };
  process.stdin.on('data', data => {
    if (timer) clearTimeout(timer);
    timer = null;
    rest += data;
    take();
  });
}

export function bracketed() {
  process.stdout.write('\x1b[?2004h');
}

/* How many characters at the end could begin the paste's end marker. */
function partialEnd(text) {
  for (let n = Math.min(PASTE_END.length - 1, text.length); n > 0; n--) if (PASTE_END.startsWith(text.slice(-n))) return n;
  return 0;
}
