import { HIDDEN, MIN_SECRET_LENGTH, redactExact, secretForms as exactForms } from '@hornhoof/protocol/redaction';
export { HIDDEN } from '@hornhoof/protocol/redaction';
export const MIN_LENGTH = MIN_SECRET_LENGTH;

/* Short values in general diagnostics would hide ordinary words. */
export const secretForms = (secrets: string[]): string[] => exactForms(secrets, 'ignore');
export const redact = (text: string, secrets: string[]): string => redactExact(text, secrets, 'ignore');

export const redactOperator = (text: string, secrets: string[]): string => redactExact(text, secrets, 'literal');

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
const AUTH_VALUE = /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_=.~-]+/gi;
const OAUTH_VALUE = /(\b(?:access_token|refresh_token|id_token)["']?\s*[:=]\s*["']?)(?:\[hidden\]|[^\s"'&,}\]]+)/gi;
const LONG_RUN = /[A-Za-z0-9+/_=-]{24,}/g;
const keyLike = (word: string): boolean => /^[0-9a-f]{32,}$/i.test(word) || (/[a-z]/.test(word) && /[A-Z]/.test(word) && /[0-9]/.test(word));

/* Hides what looks like a key or a token in words a program printed, before a person reads them. */
export function hideKeyLike(text: string): string {
  return text.replace(AUTH_VALUE, `$1${HIDDEN}`).replace(OAUTH_VALUE, `$1${HIDDEN}`).replace(KEY_PREFIX, HIDDEN).replace(LONG_RUN, word => (keyLike(word) ? HIDDEN : word));
}
