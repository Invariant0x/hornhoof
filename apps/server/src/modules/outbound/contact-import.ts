import { ZodError } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { addContact } from './contacts.js';
import { ContactTableError, readContactTable, type ImportReason, type SkippedRow } from './contact-table.js';
import type { Channel } from './policies.js';

type ImportInput = { channel: Channel; filename: string; data: string; source: string; evidence: string };

function skippedReason(error: unknown): ImportReason {
  if (error instanceof ZodError) return 'field_invalid';
  if (!(error instanceof ApiError) || ![400, 409].includes(error.status)) throw error;
  return error.status === 409 ? 'contact_suppressed' : 'address_invalid';
}

/* Consent, suppression and the contact lock are the same as adding one address. The callback keeps the same setup log. */
export async function importContacts(ctx: Pick<Ctx, 'db' | 'config'>, input: ImportInput, onAdded: (permissionId: string, kind: 'email' | 'direct') => Promise<void>) {
  const table = await readContactTable(input.filename, Buffer.from(input.data, 'base64')).catch(error => {
    if (error instanceof ContactTableError) throw new ApiError(400, 'validation', error.message, error.reason);
    throw error;
  });
  const skipped: SkippedRow[] = [...table.skipped];
  let added = 0;
  let updated = 0;
  const kind = input.channel.adapter === 'smtp' ? 'email' : 'direct';
  for (const row of table.rows) {
    try {
      const contact = await addContact(ctx, { companyId: input.channel.companyId, channel: input.channel, kind, address: row.address, fields: row.fields, source: input.source, evidence: input.evidence });
      if (contact.permissionId) { await onAdded(contact.permissionId, kind); added++; } else updated++;
    } catch (error) {
      skipped.push({ row: row.row, reason: skippedReason(error) });
    }
  }
  return { added, updated, skipped: skipped.sort((a, b) => a.row - b.row) };
}
