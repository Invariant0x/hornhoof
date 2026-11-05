import type { DepartmentTree, Org } from '../src/types';
import { wholeTurn } from './whole-turn';

export type Tree = { tree: DepartmentTree; org: Org };

/* Long texts with a word too long for a line, as branch and tool names are. */
export const LONG_TITLE = 'Move the checkout to the new payment_provider_and_keep_every_old_receipt_readable in both languages for years';
export const LONG_NAME = 'Oleg Constantinopolskyvonhohenzollernbergovich Jr';
export const LONG_ROLE = 'Engineer_of_payments_and_receipts_in_both_languages';
export const LONG_WAIT = 'Image_build_of_the_new_checkout_on_the_slowest_machine';
export const LONG_BRANCH = 'release_2026_11_checkout_with_the_new_payment_provider';

/* A department at its real size: 12 lanes and more than 50 tasks, one agent with no state to show, and very long texts. */
export function fullDepartment(): Tree {
  const { tree, org } = wholeTurn(true);
  const employees = org.departments[0]!.employees, sample = tree.lines.find(l => l.agent.name === 'Timur')!;
  org.departments[0]!.repository!.branch = LONG_BRANCH;
  tree.lines.find(l => l.externalWait)!.externalWait!.reason = LONG_WAIT;
  ['Lena', 'Mark', 'Nora', LONG_NAME].forEach((name, a) => {
    const agent = { id: `x${a}`, name };
    employees.push({ ...employees[1]!, ...agent, status: a ? 'idle' : 'off', title: name === LONG_NAME ? { en: LONG_ROLE, ru: LONG_ROLE } : employees[1]!.title });
    for (let i = 0; i < 5; i++) {
      const from = new Date(Date.parse(tree.turn!.startedAt) + (a * 50 + i * 40) * 60_000).toISOString();
      const to = new Date(Date.parse(from) + 30 * 60_000).toISOString();
      tree.lines.push({ ...sample, taskId: `x${a}-${i}`, number: 200 + a * 10 + i, title: name === 'Mark' && i === 4 ? LONG_TITLE : `Checkout part ${a}.${i}`, agent,
        createdAt: from, cutAt: from, mergedAt: to, doneAt: null, segments: [{ kind: 'work', from, to }], moves: [], lastActionAt: to, live: false });
    }
  });
  return { tree, org };
}
