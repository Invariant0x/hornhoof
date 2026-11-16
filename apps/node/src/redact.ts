export const HIDDEN = '[hidden]';
export const MIN_LENGTH = 8;
/* The shortest value held exactly: a vault password is at least this long, and shorter would hide single letters. */
export const EXACT_MIN_LENGTH = 4;

/* Values shorter than a secret usually is that the node typed into a sign-in form, a password or a one-time code, each
   hidden wherever the node's output goes until its time is over, whatever its length. */
const exact = new Map<string, number>();

export function holdExact(values: string[], untilMs: number): void {
  for (const value of values) if (value.length >= EXACT_MIN_LENGTH && (exact.get(value) ?? -Infinity) < untilMs) exact.set(value, untilMs);
}

export function forgetExact(): void {
  exact.clear();
}

function heldNow(): string[] {
  const now = Date.now();
  for (const [value, until] of exact) if (until <= now) exact.delete(value);
  return [...exact.keys()];
}

/* Every form a secret may show in, plain or base64, longest first. Short values are left out, they would hide ordinary
   words, except the ones held exactly. */
export function secretForms(secrets: string[]): string[] {
  const values = new Set<string>(heldNow());
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
