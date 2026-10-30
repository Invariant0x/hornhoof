const HIDDEN = '[hidden]';
const MIN_LENGTH = 8;

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
