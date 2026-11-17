import { z } from 'zod';

export const MAX_CONTACT_FIELD = 200;
export const MAX_CONTACT_FIELDS = 50;
export const SENDER_FIELDS = ['account_label', 'channel_name'] as const;
export const ContactFieldName = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80).refine(name => !(SENDER_FIELDS as readonly string[]).includes(name));
export const ContactFieldValue = z.string().min(1).max(MAX_CONTACT_FIELD).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u).refine(value => value.trim().length > 0);
export const ContactFields = z.record(ContactFieldName, ContactFieldValue).refine(fields => Object.keys(fields).length <= MAX_CONTACT_FIELDS);
export type ContactFields = z.infer<typeof ContactFields>;
