import { createHash } from 'node:crypto';
import type { NodeMessage } from '@hornhoof/protocol';

type LeftFrame = Omit<Extract<NodeMessage, { type: 'agent.input_left' }>, 'type'>;
/* One of Hornhoof's prompts that its program never took, for a turn Hornhoof gave up on, which Hornhoof repeats itself. */
export type OwnLeft = { text: string; jobId: string | null; at: number };

const MAX_KEPT = 64;
/* The shortest piece of a prompt that tells it apart, when the program shows only a part of what was pasted. */
const OWN_PIECE = 40;
export const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
/* What tmux pastes of these words: terminal controls in them must not end the paste or become keys, so only newline and
   tab of them stay. */
export const pastable = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
/* What a program shows in place of a long paste: the words themselves are not on its screen. */
const FOLDED = /\[Pasted (?:text|content)\b[^\]]*\]/i;
const ONLY_FOLDED = new RegExp(`^${FOLDED.source}$`, 'i');

export const holdsFoldedPaste = (input: string): boolean => FOLDED.test(input);

/* Keys that erase what the input holds, line by line, with the cursor at its end. Escape stops the program, so never that. */
export const eraseKeys = (text: string): string[] => text.split('\n').flatMap((_, i) => (i ? ['BSpace', 'C-u'] : ['C-u']));

/* The same words for the same turn have the same ref, so words told again are kept once. */
export const leftRef = (jobId: string | null, input: string): string => createHash('sha256').update(`${jobId}\n${flat(input)}`).digest('hex').slice(0, 32);

/* Text with no key of a person since Hornhoof pasted it, and that reads as that prompt. Anything else counts as someone's. */
export function isOwnLeft(own: OwnLeft | null | undefined, typedAt: number | null | undefined, input: string): boolean {
  if (!own || (typedAt ?? -Infinity) > own.at) return false;
  const left = flat(input), prompt = flat(own.text);
  return left === prompt || ONLY_FOLDED.test(left) || (left.length >= OWN_PIECE && prompt.includes(left));
}

/* Words Hornhoof was asked to keep, and which it said it keeps. */
export class LeftInputs {
  private readonly told = new Set<string>();
  private readonly waits = new Map<string, () => void>();

  constructor(private readonly send: (frame: Extract<NodeMessage, { type: 'agent.input_left' }>) => void, private readonly waitMs: number) {}

  isKept(ref: string): boolean {
    return this.told.has(ref);
  }

  async keep(frame: LeftFrame): Promise<boolean> {
    if (this.isKept(frame.ref)) return true;
    let timer: NodeJS.Timeout | undefined;
    const answered = new Promise<void>(done => {
      this.waits.set(frame.ref, done);
      timer = setTimeout(done, this.waitMs);
    });
    this.send({ type: 'agent.input_left', ...frame });
    await answered;
    clearTimeout(timer);
    this.waits.delete(frame.ref);
    return this.isKept(frame.ref);
  }

  kept(ref: string): void {
    if (this.told.size >= MAX_KEPT) this.told.clear();
    this.told.add(ref);
    this.waits.get(ref)?.();
  }
}
