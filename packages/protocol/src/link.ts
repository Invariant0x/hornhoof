/* The name of a company's public link, <name>.hornhoof.org: what the server checks and the web suggests from the
   company's name. It lives apart from the message schemas, so the web takes it without the schema library. */

export const LINK_NAME_MAX = 63;
const LINK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RANDOM_LENGTH = 24;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* Russian letters as Latin, the way people write them in addresses. */
const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', 'ё': 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/* One to 63 lowercase Latin letters, digits and hyphens, with no hyphen at either end. */
export const isLinkName = (name: string): boolean => LINK_NAME.test(name);

/* The link name a company's name gives: in Latin letters, lowercase, every run of other characters one hyphen. Empty
   when nothing in the name can be written so. */
export function linkNameOf(text: string): string {
  const latin = [...text.toLowerCase()].map(c => LATIN[c] ?? c).join('');
  const plain = latin.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, LINK_NAME_MAX).replace(/-+$/, '');
}

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
