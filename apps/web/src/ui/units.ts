/* A no-break space: the words on its two sides stay on one line. */
export const NBSP = ' ';

/* A number stays on one line with the word it goes with: the space after a number, as in "14 h" or "1 online", and the
   space after a word that names the number, as in "на связи: 1", become no-break spaces. Every other space still lets
   the words wrap, so "4 days 14 h" breaks only between "4 days" and "14 h". */
export const keepUnits = (text: string): string => text.replace(/(?<=\d) (?=\p{L})|(?<=\p{L}:) (?=\d)/gu, NBSP);
