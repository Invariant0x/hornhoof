import { inputOf } from './input.js';
import type { TermProgram } from './programs.js';

/* How often words go in at most: once and two more times. A program that lost them three times is a case for the operator. */
const MOST_TYPINGS = 3;
const compact = (text: string) => text.replace(/\s+/g, '');

/* Whether the input shows the words Hornhoof typed, as programs show them: wrapped, cut to their first rows, or folded when
   long. Anything else there is a person's. */
export function holdsWords(input: string, words: string): boolean {
  return /^\[Pasted\b/i.test(input) || compact(words).includes(compact(input).slice(0, 80));
}

type Times = { enterMs: number; quietMs: number };

/* What a turn does for words the program has not recorded: Enter again while they stay in its input, and type them again
   once its input stays empty and its screen shows no change at all, as a program at work keeps showing one. */
export class LostWords {
  private screen = '';
  private quietSince: number;
  private typings = 1;
  private typedAt: number;
  private pressedAt: number;

  constructor(private readonly words: string, private readonly times: Times, now: number) {
    this.quietSince = this.typedAt = this.pressedAt = now;
  }

  step(kind: TermProgram['kind'], screen: string, now: number): 'enter' | 'type' | null {
    if (screen !== this.screen) { this.screen = screen; this.quietSince = now; }
    const input = inputOf(kind, screen);
    if (input === null) return null;
    return input ? this.pressAgain(input, now) : this.typeAgain(now);
  }

  private pressAgain(input: string, now: number): 'enter' | null {
    if (!holdsWords(input, this.words) || now - this.pressedAt < this.times.enterMs) return null;
    this.pressedAt = now;
    return 'enter';
  }

  private typeAgain(now: number): 'type' | null {
    if (this.typings >= MOST_TYPINGS || now - Math.max(this.quietSince, this.typedAt) < this.times.quietMs) return null;
    this.typings++;
    this.typedAt = this.pressedAt = now;
    return 'type';
  }
}
