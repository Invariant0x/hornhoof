import { armor, Encrypter } from 'age-encryption';

/* A secret sealed in the browser to machines' public keys, so only they open it and Hornhoof keeps it without reading
   it. One armored file that each recipient opens. */
export async function sealFor(recipients: string[], secret: string): Promise<string> {
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return armor.encode(await e.encrypt(secret));
}
