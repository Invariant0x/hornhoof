import type { LabMachine } from './lab.js';
import { literal } from './steps.js';
import { sqlIn } from './writer.js';

/* What the lab's writer kept of one task the server confirmed: its id, when the answer came by the test's clock, and
   the machine that answered. */
export type Written = { id: string; at: number; machine: string };
export type Confirmed = Written & { term: { number: number; machine: string; split: boolean } };

/* Each kept write with the term it was written under, as the journal of that machine's database names it on the row
   of the task's insert. A write the journal does not hold is left out: the caller compares the counts. */
export async function confirmedOf(m: LabMachine, folder: string, written: Written[]): Promise<Confirmed[]> {
  if (written.length === 0) return [];
  const ids = written.map(one => literal(one.id)).join(', ');
  const out = await sqlIn(
    m, folder,
    `SELECT COALESCE(json_agg(json_build_object('id', j.key ->> 'id', 'number', j.term_number, 'machine', j.term_machine, 'split', j.term_split)), '[]')
       FROM net.journal j WHERE j.tbl = 'tasks' AND j.op = 'insert' AND j.key ->> 'id' IN (${ids})`,
  );
  const terms = new Map((JSON.parse(out) as { id: string; number: number | string; machine: string; split: boolean }[]).map(row => [row.id, { number: Number(row.number), machine: row.machine, split: row.split }]));
  return written.flatMap(one => {
    const term = terms.get(one.id);
    return term ? [{ ...one, term }] : [];
  });
}

const below = (a: Confirmed['term'], b: Confirmed['term']): boolean => a.number < b.number || (a.number === b.number && a.machine < b.machine);

/* The pairs (a, b) where b was answered after a by the test's clock and b's term stands below a's, by its number and
   then its machine, neither being a split term: a write an older leader confirmed once a newer one had confirmed one.
   None means that no two machines led at once as far as the writer saw. */
export function lateConfirms(ws: Confirmed[]): [Confirmed, Confirmed][] {
  const whole = ws.filter(one => !one.term.split).sort((a, b) => a.at - b.at);
  const pairs: [Confirmed, Confirmed][] = [];
  for (const [i, a] of whole.entries()) for (const b of whole.slice(i + 1)) if (b.at > a.at && below(b.term, a.term)) pairs.push([a, b]);
  return pairs;
}
