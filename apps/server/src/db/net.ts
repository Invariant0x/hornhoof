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
   fail inside drizzle's one transaction, which nothing can join. The journal comes off first and goes back after. */
export const BEFORE_MIGRATIONS = `DO $$ BEGIN
  IF to_regprocedure('net.detach_journal()') IS NOT NULL THEN PERFORM net.detach_journal(); END IF;
END $$`;
/* After every run and not once, so that a later migration's new table and new foreign key are covered too. */
export const AFTER_MIGRATIONS = 'SELECT net.attach_journal(); SELECT net.defer_foreign_keys();';

export function isLeaseRefused(err: unknown): boolean {
  return hasCode(err, LEASE_REFUSED);
}
