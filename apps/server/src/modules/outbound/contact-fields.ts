import { ContactFields } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { outboundContactFields } from '../../db/schema.js';
import type { Tx } from '../tasks/engine.js';

type Place = { companyId: string; departmentId: string; contactId: string };
const at = (p: Place) => and(eq(outboundContactFields.companyId, p.companyId), eq(outboundContactFields.departmentId, p.departmentId), eq(outboundContactFields.contactId, p.contactId));

/* Only the sender's department sees these values, in memory while rendering. No public view returns them. */
export async function fieldsOfContact(tx: Tx, secret: Buffer, place: Place): Promise<ContactFields> {
  const [row] = await tx.select({ fieldsEnc: outboundContactFields.fieldsEnc }).from(outboundContactFields).where(at(place));
  return row ? ContactFields.parse(JSON.parse(decryptSecret(row.fieldsEnc, secret))) : {};
}

/* The caller holds the contact lock, shared with consent, suppression and dispatch. */
export async function saveContactFields(tx: Tx, secret: Buffer, place: Place, fields: ContactFields): Promise<void> {
  if (!Object.keys(fields).length) return;
  const combined = ContactFields.parse({ ...await fieldsOfContact(tx, secret, place), ...fields });
  const fieldsEnc = encryptSecret(JSON.stringify(combined), secret);
  await tx.insert(outboundContactFields).values({ ...place, fieldsEnc }).onConflictDoUpdate({ target: [outboundContactFields.companyId, outboundContactFields.departmentId, outboundContactFields.contactId], set: { fieldsEnc } });
}
