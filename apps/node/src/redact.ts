import { HIDDEN, MIN_SECRET_LENGTH } from '@hornhoof/protocol/redaction';
export { HIDDEN } from '@hornhoof/protocol/redaction';
export const MIN_LENGTH = MIN_SECRET_LENGTH;

/* Every form a secret may show in, plain or base64, longest first. Short values are left out, they would hide ordinary words. */
export function secretForms(secrets: string[]): string[] {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_LENGTH) continue;
    const b64 = Buffer.from(secret).toString('base64');
    values.add(secret);
    values.add(b64);
    values.add(b64.replace(/=+$/, ''));
    values.add(Buffer.from(secret).toString('base64url'));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/* Replaces every exact copy of a secret before output leaves the node. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const value of secretForms(secrets)) out = out.replaceAll(value, HIDDEN);
  return out;
}

/* How many characters at the end of text could begin one of the values. */
export function secretPrefixLength(text: string, values: string[]): number {
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

/* A word that looks like a key or a token though the node was never told it: one with a key's prefix, a long run of hex,
   or a long run of letters in both cases and digits. */
const KEY_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|AKIA)[-_]?[A-Za-z0-9_-]{8,}/g;
const AUTH_VALUE = /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_=.-]+/gi;
const LONG_RUN = /[A-Za-z0-9+/_=-]{24,}/g;
const keyLike = (word: string): boolean => /^[0-9a-f]{32,}$/i.test(word) || (/[a-z]/.test(word) && /[A-Z]/.test(word) && /[0-9]/.test(word));

/* Hides what looks like a key or a token in words a program printed, before a person reads them. */
export function hideKeyLike(text: string): string {
  return text.replace(AUTH_VALUE, `$1${HIDDEN}`).replace(KEY_PREFIX, HIDDEN).replace(LONG_RUN, word => (keyLike(word) ? HIDDEN : word));
}
