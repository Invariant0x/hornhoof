const HIDDEN = '[hidden]';
const MIN_LENGTH = 8;

/* Replaces every exact copy of a secret, plain or base64, before output leaves the node. Short values are left alone, they would hide ordinary words. */
export function redact(text: string, secrets: string[]): string {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_LENGTH) continue;
    const b64 = Buffer.from(secret).toString('base64');
    values.add(secret);
    values.add(b64);
    values.add(b64.replace(/=+$/, ''));
    values.add(Buffer.from(secret).toString('base64url'));
  }
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) out = out.replaceAll(value, HIDDEN);
  return out;
}
