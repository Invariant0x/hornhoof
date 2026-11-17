import { readFileSync } from 'node:fs';
import type { Checker } from '../../checker.js';
import { reasonOf } from './machine-keys.js';

/* What a keeper wrote down in its folder of something it is in the middle of, as a switch of the server. A note that
   is not there says there is nothing; one that is there and cannot be read says neither that nor anything else, so
   whoever reads it must not go on as if there were nothing. */
export class NoteUnreadable extends Error {}

/* The note at that path, of that shape: null when there is none. Throws NoteUnreadable when the file is there and
   cannot be opened, or holds something else than the keeper wrote. what: how the note is named in the line. */
export function readNote<T>(path: string, shape: Checker<T>, what: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new NoteUnreadable(`The keeper cannot read what it wrote down of ${what}: ${reasonOf(err)}`);
  }
  try {
    return shape.parse(JSON.parse(text));
  } catch (err) {
    throw new NoteUnreadable(`The keeper cannot read what it wrote down of ${what}: ${reasonOf(err)}`);
  }
}
