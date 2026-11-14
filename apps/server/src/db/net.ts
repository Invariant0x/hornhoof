import { hasCode } from './errors.js';

/* What net.assert_lease raises when this machine holds no lease a commit may stand on. */
export const LEASE_REFUSED = 'HHF01';
/* A superuser session that sets this to 'on' is fenced; one that does not, as an older build's, passes unchecked. */
export const FENCED = 'hornhoof.fenced';
export const JOURNAL_TRIGGER = 'net_journal';
export const FENCE_TRIGGER = 'net_fence';

export type LeaseKind = 'normal' | 'split' | 'maintenance';
export type LeaseSync = 'copy' | 'relay_off' | 'alone';
export type Term = { number: number; machine: string; split: boolean };

/* Each table's journal function names its columns, so a migration that drops a column and then writes that table would
   fail inside drizzle's one transaction, which nothing can join. So a run with something to apply first leaves each table's
   trigger in place with a body that names no column and refuses a fenced session, and puts the real body back after. */
export const BEFORE_MIGRATIONS = `DO $$ BEGIN
  IF to_regprocedure('net.detach_journal()') IS NOT NULL THEN PERFORM net.detach_journal(); END IF;
END $$`;
/* After every run with something to apply and not once, so that a later migration's new table and new foreign key are covered too. */
export const AFTER_MIGRATIONS = 'SELECT net.attach_journal(); SELECT net.defer_foreign_keys();';
/* What a run that was killed can leave behind, for the next run to heal though it has nothing to apply. */
export const JOURNAL_NEEDS_PUTTING_BACK = `SELECT EXISTS (SELECT FROM net.journals_off())
  OR EXISTS (SELECT FROM net.public_tables() p WHERE NOT EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = p.tbl AND t.tgname = '${JOURNAL_TRIGGER}'))
  OR EXISTS (SELECT FROM net.foreign_keys_to_defer()) AS needed`;

export function isLeaseRefused(err: unknown): boolean {
  return hasCode(err, LEASE_REFUSED);
}
