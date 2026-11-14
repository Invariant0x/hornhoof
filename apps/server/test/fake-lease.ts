import type { LeaseKind, LeaseSync, Term } from '../src/db/net.js';
import type { LeaseStore } from '../src/modules/keeper/lease-store.js';

type Options = {
  problems?: string[];
  take?: (kind: LeaseKind) => Promise<Term>;
  renew?: () => Promise<boolean>;
  prune?: () => Promise<number>;
  othersHoldData?: boolean | null;
};

/* A lease store that keeps no database: each take gives the next term of machine-a, each renewal holds, every fence
   stands and no other machine holds the data, unless a test says otherwise. It lists the calls it got, in order. */
export function fakeLease(opts: Options = {}): LeaseStore & { calls: { method: string; args: unknown[] }[]; problemsAre(lines: string[]): void; othersHold(now: boolean | null): void } {
  const calls: { method: string; args: unknown[] }[] = [];
  let taken = 0;
  let problems = opts.problems ?? [];
  let others: boolean | null = opts.othersHoldData ?? false;
  const said = <T>(method: string, args: unknown[], answer: T): T => {
    calls.push({ method, args });
    return answer;
  };
  return {
    calls,
    problemsAre: lines => { problems = lines; },
    othersHold: now => { others = now; },
    take: (kind, until, sync?: LeaseSync, term?: Term) => said('take', term ? [kind, until, sync, term] : [kind, until, sync], opts.take ? opts.take(kind) : term ? Promise.resolve((taken = term.number, term)) : Promise.resolve({ number: ++taken, machine: 'machine-a', split: false })),
    renew: (term, kind, until, endSessions, sync?: LeaseSync) => said('renew', [term, kind, until, endSessions, sync], opts.renew ? opts.renew() : Promise.resolve(true)),
    fence: () => said('fence', [], Promise.resolve()),
    endSessions: () => said('endSessions', [], Promise.resolve(0)),
    problems: () => said('problems', [], Promise.resolve(problems)),
    prune: batch => said('prune', [batch], opts.prune ? opts.prune() : Promise.resolve(0)),
    othersHoldData: () => Promise.resolve(others),
    close: () => said('close', [], Promise.resolve()),
  };
}
