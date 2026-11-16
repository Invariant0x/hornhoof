import { z } from 'zod';
import { FillAddress, SiteSession } from './secret-fill.js';

/* How an agent's hh-browse opens a page with a sign-in saved for it: Hornhoof seals the sign-in to the node's own key, the
   node opens it, hides its values from everything it says, reads the page in a browser of the node's own process and
   answers with what the page shows. No cookie passes the agent's process, its turn or its tools. */

/* The limits of one call, as hh-browse lets an agent set them. */
export const BrowseLimits = z.strictObject({
  timeoutMs: z.number().int().min(5_000).max(120_000),
  maxText: z.number().int().min(1000).max(200_000),
  maxLinks: z.number().int().min(0).max(1000),
  maxBytes: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024),
});
export type BrowseLimits = z.infer<typeof BrowseLimits>;

/* An armored age message to one node's key: a session holds at most a frame. */
const SealedSignIn = z.string().min(1).max(2 * 1024 * 1024);

export const SignedInBrowse = z.strictObject({
  type: z.literal('signin.browse'),
  requestId: z.uuid(),
  jobId: z.uuid(),
  sealed: SealedSignIn,
  address: FillAddress,
  fullPage: z.boolean(),
  waitFor: z.string().min(1).max(500).nullable(),
  screenshot: z.boolean(),
  limits: BrowseLimits,
  /* The node starts no page after this, whatever its own clock says of the server's. */
  expiresAt: z.iso.datetime(),
});
export type SignedInBrowse = z.infer<typeof SignedInBrowse>;

/* What the sealed part holds once the node opens it: the site's sign-in and the browser a person made it in. */
export const SignedInPlain = z.strictObject({ session: SiteSession, userAgent: z.string().min(1).max(1000).nullable() });
export type SignedInPlain = z.infer<typeof SignedInPlain>;

export const PAGE_STATUSES = ['ok', 'login_required', 'robot_check', 'http_error', 'refused', 'failed'] as const;
const PageLink = z.strictObject({ text: z.string().max(2000), url: z.string().max(4096) });
/* What hh-browse prints of a page, with no file of the node's: the picture comes apart. */
export const BrowsedPage = z.strictObject({
  status: z.enum(PAGE_STATUSES),
  reason: z.string().max(2000).nullable(),
  address: z.string().max(4096),
  finalAddress: z.string().max(4096).nullable(),
  httpStatus: z.number().int().nullable(),
  title: z.string().max(4096).nullable(),
  text: z.string().max(200_000).nullable(),
  textLength: z.number().int().nonnegative(),
  links: z.array(PageLink).max(1000),
  linkCount: z.number().int().nonnegative(),
  notes: z.array(z.string().max(2000)).max(50),
});
export type BrowsedPage = z.infer<typeof BrowsedPage>;

/* A screenshot as base64 PNG, within what one frame carries beside the page. */
export const BROWSED_SHOT_MAX = 2_500_000;
/* expired: it came too late to start; unopened: the sealed part is not for this node; failed: anything else. */
export const BROWSE_FAILURES = ['expired', 'unopened', 'failed'] as const;
export const SignedInBrowsed = z.strictObject({
  type: z.literal('signin.browsed'),
  requestId: z.uuid(),
  page: BrowsedPage.nullable(),
  shot: z.string().max(BROWSED_SHOT_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
  failure: z.enum(BROWSE_FAILURES).optional(),
});
export type SignedInBrowsed = z.infer<typeof SignedInBrowsed>;
