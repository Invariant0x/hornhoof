/* The name of a company's public link, <name>.hornhoof.org: what the server checks, and the random one the web offers.
   It lives apart from the message schemas, so the web takes it without the schema library. */

const LINK_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RANDOM_LENGTH = 24;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* One to 63 lowercase Latin letters, digits and single hyphens, with no hyphen at either end. */
export const isLinkName = (name: string): boolean => LINK_NAME.test(name);

/* A long random name nobody guesses. Bytes past the last whole round of the alphabet are skipped, so every character
   is as likely as any other. */
export function randomLinkName(): string {
  let name = '';
  const limit = 256 - (256 % ALPHABET.length);
  while (name.length < RANDOM_LENGTH) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH * 2))) {
      if (byte < limit && name.length < RANDOM_LENGTH) name += ALPHABET[byte % ALPHABET.length];
    }
  }
  return name;
}
