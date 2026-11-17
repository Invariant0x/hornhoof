import { cleanDiagnostic } from '@hornhoof/protocol/redaction';

/* The most a failure collector reads of what a holder said comes next. */
const NEXT_MAX = 500;

/* Where a report says what comes next: a heading named Next, or Next (steps) before a colon, bold or not. */
const NEXT = /^[ \t]*#{1,6}[ \t]*Next(?: steps?)?[ \t]*:?[ \t]*$|(?:\*\*|__)?\bNext(?: steps?)?\b(?:\*\*|__)?[ \t]*:(?:\*\*|__)?/gm;

/* Where the section after it ends: a line that starts another one, as a heading, a bold label before a colon or one of the
   report's own labels, or one of those labels later in the same line. */
const SECTION = /\n[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]|(?:\*\*|__)[^*_\n]{1,40}(?:\*\*|__)?[ \t]*:|(?:Status|What changed|Evidence|Concerns)[ \t]*:)|[ \t](?:\*\*|__)?(?:Status|What changed|Evidence|Concerns)(?:\*\*|__)?[ \t]*:/;

/* What a holder said comes next, from the words it stopped with: the last Next section of its report, else the end of the
   report. Cleaned of credentials and private paths before anything is read out of it or cut, so that no part of one is
   left at an edge, whoever reads it. */
export function nextSection(report: string): string {
  const cleaned = cleanDiagnostic(report).trim();
  const start = [...cleaned.matchAll(NEXT)].at(-1);
  const rest = start ? cleaned.slice(start.index + start[0].length) : '';
  const end = rest.search(SECTION);
  const section = (end < 0 ? rest : rest.slice(0, end)).trim();
  return section ? section.slice(0, NEXT_MAX) : cleaned.slice(-NEXT_MAX);
}
