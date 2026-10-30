import { redact, secretForms } from '../redact.js';

/* Hides secrets in a screen that arrives in pieces. The end of a piece that could be the start of a secret waits for the
   next piece, or for flush() when the screen goes quiet. */
export class StreamMask {
  private held = '';

  constructor(private readonly secrets: () => string[]) {}

  push(chunk: string): string {
    const secrets = this.secrets();
    const text = redact(this.held + chunk, secrets);
    const keep = longestStart(text, secretForms(secrets));
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
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
