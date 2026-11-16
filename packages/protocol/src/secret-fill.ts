import { z } from 'zod';

/* How a node fills a sign-in of the company's vault into a form with no value passing the model: Hornhoof seals the
   values to the node's own key, the node opens them, hides them from everything it says, types them into the target and
   answers with a status only. One mechanism for the node's browser and for a company phone. */

export const FILL_FIELDS = ['login', 'password', 'code'] as const;
export const FillField = z.enum(FILL_FIELDS);
export type FillField = z.infer<typeof FillField>;

const FILL_KINDS = ['browser', 'phone'] as const;
export const FillKind = z.enum(FILL_KINDS);
export type FillKind = z.infer<typeof FillKind>;

/* filled: the fields went in; signed_in: the browser got past the sign-in; field_not_found and wrong_field: the target
   has no such field, or the one meant is not a password field; rejected: the site said the sign-in is wrong; needs_person,
   robot_check and browser_refused: only a person goes on; target_gone: the page or phone session is over; expired: it came
   too late; unsupported: the node fills no such target; failed: anything else, told with no words of its own. */
const FILL_STATUSES = ['filled', 'signed_in', 'field_not_found', 'wrong_field', 'rejected', 'needs_person', 'robot_check', 'browser_refused', 'target_gone', 'expired', 'unsupported', 'failed'] as const;
export const FillStatus = z.enum(FILL_STATUSES);
export type FillStatus = z.infer<typeof FillStatus>;

const FILL_ADDRESS_MAX = 2048;
const webAddress = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
};
export const FillAddress = z.string().max(FILL_ADDRESS_MAX).refine(webAddress, 'A sign-in opens only a web address.');

const siteOf = (address: string): { protocol: string; host: string } | null => {
  try {
    const url = new URL(address);
    return { protocol: url.protocol, host: url.hostname.toLowerCase() };
  } catch {
    return null;
  }
};

/* A page of the same site as a sign-in's address, where its values may be typed: the same host or one under the other,
   and never a step down from https. */
export function sameSite(address: string, page: string): boolean {
  const a = siteOf(address);
  const b = siteOf(page);
  if (!a || !b || !a.host || !b.host) return false;
  if (b.protocol !== a.protocol && b.protocol !== 'https:') return false;
  return a.host === b.host || a.host.endsWith(`.${b.host}`) || b.host.endsWith(`.${a.host}`);
}

export const FillTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('browser'), address: FillAddress }),
  /* element: the phone's own reference to the field, from its sanitized tree; none types into the focused field. site:
     the entry's web address, so a page open in the phone's browser is checked to be of its site; none for an app. */
  z.strictObject({ kind: z.literal('phone'), phoneSessionId: z.uuid(), generation: z.number().int().nonnegative(), element: z.string().min(1).max(200).nullable(), site: FillAddress.nullable() }),
]);
export type FillTarget = z.infer<typeof FillTarget>;

const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const Fields = z.array(FillField).min(1).max(FILL_FIELDS.length).refine(distinct, 'Each field is named once.');

const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export const FillTotp = z.strictObject({
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
  period: z.number().int().min(15).max(120),
  algorithm: z.enum(TOTP_ALGORITHMS),
});
export type FillTotp = z.infer<typeof FillTotp>;

/* What the sealed part holds once the node opens it. A password under four characters is refused where it is saved, so
   hiding it from the node's output never hides ordinary letters. */
export const FILL_PASSWORD_MIN = 4;
export const FillPlain = z.strictObject({
  login: z.string().min(1).max(320),
  password: z.string().min(FILL_PASSWORD_MIN).max(1024),
  totp: FillTotp.nullable(),
});
export type FillPlain = z.infer<typeof FillPlain>;

/* An armored age message to one node's key. */
const SealedFill = z.string().min(1).max(64 * 1024);

export const SecretFill = z.strictObject({
  type: z.literal('secret.fill'),
  requestId: z.uuid(),
  jobId: z.uuid().nullable(),
  entryId: z.uuid(),
  sealed: SealedFill,
  fields: Fields,
  target: FillTarget,
  /* The node starts no fill after this, whatever its own clock says of the server's. */
  expiresAt: z.iso.datetime(),
});
export type SecretFill = z.infer<typeof SecretFill>;

/* The site's sign-in after the node's browser got past it, as Playwright keeps a storage state: Hornhoof hands it to the
   agent's saved sign-ins and never shows it. */
const Cookie = z.object({
  name: z.string().max(4096),
  value: z.string().max(8192),
  domain: z.string().max(255),
  path: z.string().max(1024),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});
export const SiteSession = z.object({
  cookies: z.array(Cookie).max(1000),
  origins: z.array(z.object({ origin: z.string().max(FILL_ADDRESS_MAX), localStorage: z.array(z.object({ name: z.string().max(4096), value: z.string().max(65_536) })).max(500) })).max(20),
});
export type SiteSession = z.infer<typeof SiteSession>;

/* A screenshot of the page with every sign-in field already painted over, as base64 PNG. */
export const FILL_SHOT_MAX = 1_500_000;
export const SecretFilled = z.strictObject({
  type: z.literal('secret.filled'),
  requestId: z.uuid(),
  status: FillStatus,
  filled: z.array(FillField).max(FILL_FIELDS.length).refine(distinct),
  session: SiteSession.optional(),
  shot: z.string().max(FILL_SHOT_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
});
export type SecretFilled = z.infer<typeof SecretFilled>;
