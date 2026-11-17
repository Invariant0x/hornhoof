import { createHash, createHmac } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { FEEDBACK_KINDS, machines } from '../../db/schema.js';
import { cleanText, type Hidden } from './clean.js';
import { ISSUE_REPOSITORY } from './github-issue.js';

/* A report to Hornhoof's developers as it travels from an installation through hornhoof.org to the inbox, version 1. The
   installation signs it with an id of its own that tells nothing about it. Nothing else of the company goes with it. */

export const TITLE_MAX = 200;
export const TEXT_MAX = 5000;
/* How many more rounds found a report already sent, told at once. */
export const REPEATS_MAX = 100;
const PLATFORMS_MAX = 10;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/* What a platform is written with: an operating system and an architecture, as a machine says them. */
const PLATFORM = /^[a-z0-9_.-]{1,40}(?: [a-z0-9_.-]{1,40})?$/;

export const Facts = z.strictObject({
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  platform: z.array(z.string().regex(PLATFORM)).max(PLATFORMS_MAX),
  errorCode: z.string().regex(CODE).nullable(),
});
export type Facts = z.infer<typeof Facts>;

/* What a screen should not take: control characters other than line breaks and tabs, and the marks that turn the
   direction of text. */
const UNSEEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/* A title keeps a word once those are dropped, or it would show as empty. */
const Title = z.string().trim().min(1).max(TITLE_MAX).refine(title => title.replace(UNSEEN, '').trim() !== '');
const Text = z.string().trim().max(TEXT_MAX);
export const Kind = z.enum(FEEDBACK_KINDS);

export const Report = z.strictObject({
  v: z.literal(1),
  installation: z.string().regex(/^[0-9a-f]{32}$/),
  kind: Kind,
  title: Title,
  text: Text,
  facts: Facts,
  /* A report sent again, word for word, to say how many more rounds found it since. */
  repeats: z.int().min(1).max(REPEATS_MAX).optional(),
});
export type Report = z.infer<typeof Report>;
export type Shown = Omit<Report, 'v' | 'installation' | 'repeats'>;

/* What a person writes in the feedback window, and the finding it was opened from, if any. */
export const Written = z.strictObject({ kind: Kind, title: Title, text: Text, improvement: z.uuid().optional() });
export type Written = z.infer<typeof Written>;

/* An issue of Hornhoof's repository on GitHub. Its page is only ever the exact one of its number there, so an answer that
   passed hornhoof.org cannot put any other link on a card. */
export type IssueLink = { number: number; url: string };
const ISSUE_PAGE = new RegExp(`^https://github\\.com/${ISSUE_REPOSITORY}/issues/([1-9][0-9]{0,9})$`, 'i');
const Issue = z.object({ number: z.int().positive(), url: z.string() });
export const issuePage = (number: number) => `https://github.com/${ISSUE_REPOSITORY}/issues/${number}`;
export function issueLinkOf(value: unknown): IssueLink | null {
  const found = Issue.safeParse(value);
  const page = found.success ? ISSUE_PAGE.exec(found.data.url) : null;
  return found.success && page && Number(page[1]) === found.data.number ? { number: found.data.number, url: issuePage(found.data.number) } : null;
}

/* What the inbox answered a report with, through hornhoof.org: the number of its card there and its issue, if any. An
   answer of another shape tells neither. */
const Answer = z.object({ number: z.int().positive(), issue: z.unknown().optional() });
export function answerOf(body: unknown): { number: number | null; issue: IssueLink | null } {
  const found = Answer.safeParse(body);
  return found.success ? { number: found.data.number, issue: issueLinkOf(found.data.issue) } : { number: null, issue: null };
}

/* The same id for every report of this installation, made from its secret by a one-way hash, so it reveals neither. */
export const installationOf = (secret: Buffer): string => createHmac('sha256', secret).update('hornhoof feedback installation').digest('hex').slice(0, 32);

/* The Hornhoof version this server runs, and the systems of the company's machines that are still in use, without their
   names. */
export async function factsOf(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string, errorCode: string | null): Promise<Facts> {
  const rows = await ctx.db.select({ os: machines.os, arch: machines.arch }).from(machines).where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)));
  const platform = [...new Set(rows.map(r => `${r.os} ${r.arch}`.trim().toLowerCase()).filter(p => PLATFORM.test(p)))].sort().slice(0, PLATFORMS_MAX);
  return { version: ctx.config.version, platform, errorCode };
}

/* Cleans a title or a text and drops what a screen should not take. */
export function cleaned(text: string): { text: string; hidden: Hidden } {
  const once = cleanText(text.replace(UNSEEN, ''));
  return { text: once.text.trim(), hidden: once.hidden };
}

const sum = (a: Hidden, b: Hidden): Hidden => ({ secret: a.secret + b.secret, email: a.email + b.email, address: a.address + b.address, path: a.path + b.path });

/* What a person sees in the window and the installation then sends, as one: the cleaned words, the technical data and what
   was hidden, with a digest of exactly that. */
export function shownOf(written: Pick<Written, 'kind' | 'title' | 'text'>, facts: Facts): { report: Shown; hidden: Hidden; digest: string } {
  const title = cleaned(written.title);
  const text = cleaned(written.text);
  /* A mark can be longer than what it hides, so the cleaned words are cut to what a report holds. */
  const report = { kind: written.kind, title: title.text.slice(0, TITLE_MAX), text: text.text.slice(0, TEXT_MAX), facts };
  return { report, hidden: sum(title.hidden, text.hidden), digest: digestOf(report) };
}

export const digestOf = (report: Shown): string =>
  createHash('sha256').update(JSON.stringify([report.kind, report.title, report.text, report.facts.version, report.facts.platform, report.facts.errorCode])).digest('hex');
