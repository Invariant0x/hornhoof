/* What changed between two versions of a catalog entry, word by word: the words both have, those added and those taken
   out. A place a message fills in, as a price or a link, is one piece of its own. */

export type Token = { text: string; slot?: string };
export type Piece = Token & { change: 'same' | 'added' | 'removed' };
type Part = { kind: 'text'; text: string } | { kind: 'slot'; type: string };

/* Words and the spaces between them, each a piece, so that a change of one word leaves its neighbours alone. */
export const wordsOf = (text: string): Token[] => text.split(/(\s+)/).filter(Boolean).map(word => ({ text: word }));

export const partsAsTokens = (parts: readonly Part[]): Token[] => parts.flatMap(part => (part.kind === 'text' ? wordsOf(part.text) : [{ text: '', slot: part.type }]));

const keyOf = (token: Token): string => (token.slot === undefined ? `w${token.text}` : `s${token.slot}`);

/* Beyond this many pairs of words the comparison costs more than it tells: one version is shown whole for the other. */
const MOST_PAIRS = 250_000;

/* The longest run of tokens both have, kept from the end, so that the pieces read from the start. */
function common(before: readonly Token[], after: readonly Token[]): number[][] {
  const kept = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      kept[i]![j] = keyOf(before[i]!) === keyOf(after[j]!) ? kept[i + 1]![j + 1]! + 1 : Math.max(kept[i + 1]![j]!, kept[i]![j + 1]!);
    }
  }
  return kept;
}

const isSpace = (piece: Piece): boolean => piece.change === 'same' && piece.slot === undefined && /^\s+$/.test(piece.text);

/* A space both versions have between two changes is part of the change, and within a change what was taken out reads
   before what was put in: "soon." for "on Sunday.", not "on" and "Sunday." around a space of their own. */
function grouped(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  let run: Piece[] = [];
  const flush = () => {
    out.push(...run.filter(p => p.change === 'removed'), ...run.filter(p => p.change === 'added'));
    run = [];
  };
  pieces.forEach((piece, at) => {
    const between = isSpace(piece) && run.length > 0 && pieces[at + 1] !== undefined && pieces[at + 1]!.change !== 'same';
    if (between) run.push({ ...piece, change: 'removed' }, { ...piece, change: 'added' });
    else if (piece.change !== 'same') run.push(piece);
    else {
      flush();
      out.push(piece);
    }
  });
  flush();
  return out;
}

/* Neighbouring words of one kind of change read as one piece; a place stays a piece of its own. */
function merged(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && last.change === piece.change && last.slot === undefined && piece.slot === undefined) last.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

/* The next step from the token at i of the one version and at j of the other: both the same, one taken out, or one put
   in, as keeps the longest run of tokens both have. */
function stepAt(kept: number[][], before: readonly Token[], after: readonly Token[], i: number, j: number): Piece['change'] {
  if (i >= before.length) return 'added';
  if (j >= after.length) return 'removed';
  if (keyOf(before[i]!) === keyOf(after[j]!)) return 'same';
  return kept[i + 1]![j]! >= kept[i]![j + 1]! ? 'removed' : 'added';
}

export function changes(before: readonly Token[], after: readonly Token[]): Piece[] {
  if (before.length * after.length > MOST_PAIRS) return merged([...before.map(t => ({ ...t, change: 'removed' as const })), ...after.map(t => ({ ...t, change: 'added' as const }))]);
  const kept = common(before, after);
  const pieces: Piece[] = [];
  for (let i = 0, j = 0; i < before.length || j < after.length; ) {
    const change = stepAt(kept, before, after, i, j);
    pieces.push({ ...(change === 'removed' ? before[i]! : after[j]!), change });
    if (change !== 'added') i += 1;
    if (change !== 'removed') j += 1;
  }
  return merged(grouped(pieces));
}
