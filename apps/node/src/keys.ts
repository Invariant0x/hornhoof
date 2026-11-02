import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armor, Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

/* The node's own key pair. Hornhoof seals a plan's sign-in to the public half, so only this node opens it; the private
   half stays in the node's folder, readable by the node alone. X25519, the kind Hornhoof's protocol takes. */
export async function nodeIdentity(dir: string): Promise<{ identity: string; recipient: string }> {
  const file = join(dir, 'node-key');
  let identity = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (!identity.startsWith('AGE-SECRET-KEY-1')) {
    identity = await generateX25519Identity();
    writeFileSync(file, identity + '\n', { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return { identity, recipient: await identityToRecipient(identity) };
}

/* One armored file that each of the recipients opens. */
export async function seal(plain: Uint8Array, recipients: string[]): Promise<string> {
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return armor.encode(await e.encrypt(plain));
}

/* Throws on a file not sealed to this identity, or broken. */
export async function unseal(sealed: string, identity: string): Promise<Uint8Array> {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(armor.decode(sealed), 'uint8array');
}
