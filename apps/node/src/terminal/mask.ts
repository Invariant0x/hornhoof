import { HIDDEN, MIN_LENGTH, redact, secretForms } from '../redact.js';

/* Hides secrets in a screen that arrives in pieces. The end of a piece that could be the start of a secret waits for the
   next piece, or for flush() when the screen goes quiet. A start that went out then is remembered, so the rest of the
   secret is hidden when it comes, and once it is long enough to tell something it goes out hidden too.
   The end of a control sequence that is whole draws nothing, and most frames end in one. It goes out with its frame and is
   remembered the same way: holding it would cut the frame in two and make it wait for the quiet. */
export class StreamMask {
  private held = '';
  private sent = '';

  constructor(private readonly secrets: () => string[]) {}

  push(chunk: string): string {
    const secrets = this.secrets();
    const forms = secretForms(secrets);
    let text = this.held + chunk;
    this.held = '';
    if (this.sent) {
      const go = goOn(this.sent, text, forms);
      if (go === 'partly') {
        this.held = text;
        return '';
      }
      this.sent = '';
      if (go !== null) text = HIDDEN + text.slice(go);
    }
    text = redact(text, secrets);
    const keep = longestStart(text, forms);
    if (keep && keep < closingSequence(text)) {
      this.sent = text.slice(text.length - keep);
      return text;
    }
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    if (!this.held) return '';
    const start = this.sent + this.held;
    const out = start.length >= MIN_LENGTH ? HIDDEN : this.held;
    this.sent = start;
    this.held = '';
    return out;
  }
}

/* The length of the control sequence that text ends in, when it is whole. */
const closingSequence = (text: string): number => /\x1b\[[0-?]*[ -/]*[@-~]$/.exec(text)?.[0].length ?? 0;

/* How text goes on from a start that is already out: with the rest of a secret (its length), with a piece of that rest
   ('partly'), or with something else (null). */
function goOn(sent: string, text: string, values: string[]): number | 'partly' | null {
  for (const value of values) {
    for (let n = Math.min(value.length - 1, sent.length); n > 0; n--) {
      if (!sent.endsWith(value.slice(0, n))) continue;
      const rest = value.slice(n);
      if (text.startsWith(rest)) return rest.length;
      if (rest.startsWith(text)) return 'partly';
    }
  }
  return null;
}

/* How many characters at the end of text could begin one of the values. */
function longestStart(text: string, values: string[]): number {
  let best = 0;
  for (const value of values) {
    for (let n = Math.min(value.length - 1, text.length); n > best; n--) {
      if (text.endsWith(value.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}
