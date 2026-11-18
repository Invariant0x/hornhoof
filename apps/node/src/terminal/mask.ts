import { HIDDEN, MIN_LENGTH, redact, secretForms, secretPrefixLength } from '../redact.js';

/* Hides secrets in a screen that arrives in pieces. The end of a piece that could be the start of a secret waits for the
   next piece, or for flush() when the screen goes quiet. A start that went out then is remembered, so the rest of the
   secret is hidden when it comes, and once it is long enough to tell something it goes out hidden too.
   The end of a control sequence that is whole draws nothing, and most frames end in one. It goes out with its frame and is
   remembered the same way: holding it would cut the frame in two and make it wait for the quiet. */
export class StreamMask {
  private held = '';
  private sent = '';
  private readonly privateMask: PrivateStreamMask;

  constructor(private readonly secrets: () => string[], privateValues: () => string[] = () => []) {
    this.privateMask = new PrivateStreamMask(privateValues);
  }

  push(chunk: string): string {
    return this.pushKnown(this.privateMask.push(chunk));
  }

  private pushKnown(chunk: string): string {
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
    const keep = secretPrefixLength(text, forms);
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

  end(): string { return this.pushKnown(this.privateMask.end()) + this.flush(); }
}

/* Tmux inserts cursor and style sequences into text. Match the text across those sequences and leave the controls intact. */
const controls = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const unfinished = /\x1b(?:\[[0-?]*[ -/]*)?$/;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class PrivateStreamMask {
  private held = '';
  private forms: string[] = [];
  private pattern: RegExp | null = null;

  constructor(private readonly values: () => string[]) {}

  push(chunk: string): string {
    const forms = this.values();
    if (!forms.length && !this.held) return chunk;
    if (this.forms !== forms) {
      this.forms = forms;
      this.pattern = new RegExp([HIDDEN, ...forms].map(escape).join('|'), 'g');
    }
    const raw = this.held + chunk;
    const partial = unfinished.exec(raw);
    const end = partial?.index ?? raw.length;
    const positions: number[] = [];
    const runs: string[] = [];
    let from = 0;
    for (const control of raw.slice(0, end).matchAll(controls)) {
      runs.push(raw.slice(from, control.index));
      for (; from < control.index; from++) positions.push(from);
      from += control[0].length;
    }
    runs.push(raw.slice(from, end));
    for (; from < end; from++) positions.push(from);
    const visible = runs.join('');
    const out: string[] = [];
    let copied = 0;
    let matched = 0;
    for (const match of visible.matchAll(this.pattern!)) {
      const first = positions[match.index]!;
      matched = match.index + match[0].length;
      const last = positions[matched - 1]! + 1;
      out.push(raw.slice(copied, first), HIDDEN, ...(raw.slice(first, last).match(controls) ?? []));
      copied = last;
    }
    const keep = secretPrefixLength(visible.slice(matched), forms);
    const until = keep ? positions[visible.length - keep]! : end;
    this.held = raw.slice(until);
    out.push(raw.slice(copied, until));
    return out.join('');
  }

  /* At EOF no continuation is possible. Still keep a possible prefix out of the recording. */
  end(): string {
    const out = this.held ? HIDDEN : '';
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
