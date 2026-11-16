import { describe, expect, it } from 'vitest';
import { changes, partsAsTokens, wordsOf } from '../src/ui/catalog-diff';

const said = (pieces: ReturnType<typeof changes>) => pieces.map(p => [p.change, p.slot ? `[${p.slot}]` : p.text]);

describe('what changed between two versions of a catalog entry', () => {
  it('keeps the words both have and marks those added and taken out, spaces with them', () => {
    expect(said(changes(wordsOf('The spring sale ends soon.'), wordsOf('The spring sale ends on Sunday.')))).toEqual([
      ['same', 'The spring sale ends '],
      ['removed', 'soon.'],
      ['added', 'on Sunday.'],
    ]);
  });

  it('reads two words put in for one, with the space they share, as one change', () => {
    expect(said(changes(wordsOf('The sale ends soon. '), wordsOf('The sale ends on Sunday. ')))).toEqual([
      ['same', 'The sale ends '],
      ['removed', 'soon. '],
      ['added', 'on Sunday. '],
    ]);
  });

  it('says nothing changed for the same words', () => {
    expect(said(changes(wordsOf('Hello there'), wordsOf('Hello there')))).toEqual([['same', 'Hello there']]);
  });

  it('marks everything added against nothing, and everything taken out against nothing', () => {
    expect(said(changes([], wordsOf('Hello there')))).toEqual([['added', 'Hello there']]);
    expect(said(changes(wordsOf('Hello there'), []))).toEqual([['removed', 'Hello there']]);
  });

  it('takes a place for a price or a link as one piece, moved or not', () => {
    const before = partsAsTokens([{ kind: 'text', text: 'Only ' }, { kind: 'slot', type: 'price' }, { kind: 'text', text: ' today.' }]);
    const after = partsAsTokens([{ kind: 'text', text: 'Only today: ' }, { kind: 'slot', type: 'price' }, { kind: 'text', text: '. ' }, { kind: 'slot', type: 'link' }]);
    const pieces = changes(before, after);
    const read = (keep: string[]) => pieces.filter(p => keep.includes(p.change)).map(p => (p.slot ? `[${p.slot}]` : p.text)).join('');
    expect(read(['same', 'removed'])).toBe('Only [price] today.');
    expect(read(['same', 'added'])).toBe('Only today: [price]. [link]');
    expect(pieces.filter(p => p.slot).map(p => [p.change, p.slot])).toEqual([['same', 'price'], ['added', 'link']]);
  });

  it('gives up on a word by word comparison of very long texts and shows one whole for the other', () => {
    const long = (word: string) => wordsOf(Array.from({ length: 800 }, (_, i) => `${word}${i}`).join(' '));
    const pieces = changes(long('a'), long('b'));
    expect(pieces.map(p => p.change)).toEqual(['removed', 'added']);
  });
});
