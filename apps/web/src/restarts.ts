import type { Messages } from './i18n';

/* A turn a node restart cut off, in the person's language: the node and when, why, and which turn by its first part. */
export function cutLine(t: Messages, cut: { node: string | null; cause: string; job: string }, at: string): string {
  return `${cut.node ?? t.restarts.builtin}, ${at}. ${t.restarts.causes[cut.cause] ?? t.restarts.causes.unknown} ${t.restarts.turn(cut.job.slice(0, 8))}`;
}
