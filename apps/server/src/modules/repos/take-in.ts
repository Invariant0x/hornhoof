import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Holds } from './prune-plan.js';
import { refusalOf, type Push } from './ref-push.js';

/* A checked candidate taken into a turn branch as a merge commit of its own, which names the task (#1964). The merge has the
   candidate's own tree, so what the candidate's checks proved is what the turn branch holds, and the turn's history shows
   which tasks it was built from after their branches are gone. Where the candidate does not hold the turn branch, a merge
   would bring other work in, with a tree nobody checked: it is refused and the task goes back for a take-in. */

export type Who = { name: string; email: string };
/* branch: the branch of the candidate, for the words that tell its holder what to do. */
export type TakeIn = { task: number; turn: string; turnHead: string; candidate: string; who: Who; branch?: string };
export type TakeInDeps = {
  holds: Holds;
  /* The tree a commit has, or none where the repository could not say. */
  treeOf: (commit: string) => Promise<string | null>;
  push: Push;
  now: () => number;
};
/* merge: the commit now at the turn branch. already: the turn branch holds the candidate, so there is nothing to take in.
   stale: the candidate must take the turn branch in and be checked again. */
export type Taken = { merge: string } | { already: true } | { problem: string; stale?: true };

const TURN = /^turn-\d+$/;
const SHA1 = /^[0-9a-f]{40}$/;
const unreadable = (what: string): Taken => ({ problem: `${what} could not be read, so nothing was taken in. Try again.` });

export const takeInMessage = (task: number, who: Who): string => `Take in task-${task} (#${task})\n\nSigned-off-by: ${who.name} <${who.email}>\n`;

/* The commit as git writes it: the tree, the turn branch first and the candidate second, the author and the committer. */
function commitText(tree: string, parents: readonly string[], who: Who, seconds: number, message: string): Buffer {
  const person = `${who.name} <${who.email}> ${seconds} +0000`;
  return Buffer.from([`tree ${tree}`, ...parents.map(p => `parent ${p}`), `author ${person}`, `committer ${person}`, '', message].join('\n'), 'utf8');
}

const objectId = (body: Buffer): string => createHash('sha1').update(`commit ${body.length}\0`).update(body).digest('hex');

/* A pack of that one commit: git's header, the object's type and size as git packs them, the deflated text, the checksum. */
function packOf(body: Buffer): Buffer {
  const size: number[] = [];
  let rest = body.length >> 4;
  size.push((1 << 4) | (body.length & 0x0f) | (rest ? 0x80 : 0));
  while (rest) {
    size.push((rest & 0x7f) | (rest >> 7 ? 0x80 : 0));
    rest >>= 7;
  }
  const head = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, ...size]);
  const pack = Buffer.concat([head, deflateSync(body)]);
  return Buffer.concat([pack, createHash('sha1').update(pack).digest()]);
}

type Ready = 'ready' | 'already' | 'stale' | 'unreadable';

/* What the turn branch and the candidate are to each other: one holds the other, or each has what the other lacks. */
async function stateOf(input: TakeIn, holds: Holds): Promise<Ready> {
  const inTurn = await holds(input.turnHead, input.candidate);
  if (inTurn === true) return 'already';
  const holdsTurn = await holds(input.candidate, input.turnHead);
  if (inTurn === null || holdsTurn === null) return 'unreadable';
  return holdsTurn ? 'ready' : 'stale';
}

/* Takes the candidate into the turn branch by a merge of its own, once, only while the turn branch is still where it was read. */
export async function takeIn(input: TakeIn, deps: TakeInDeps): Promise<Taken> {
  const { task, turn, turnHead, candidate, who, branch } = input;
  if (!TURN.test(turn)) return { problem: `${JSON.stringify(turn)} is not a turn branch: work is taken into a turn branch alone.` };
  if (![turnHead, candidate].every(sha => SHA1.test(sha))) return { problem: 'A commit is not one git takes.' };
  const state = await stateOf(input, deps.holds);
  if (state === 'already') return { already: true };
  if (state === 'unreadable') return unreadable(`Whether ${turn} and the candidate hold each other`);
  if (state === 'stale') return { problem: `The candidate ${candidate.slice(0, 9)} does not hold ${turn} at ${turnHead.slice(0, 9)}: take ${turn} into ${branch ?? "the task's branch"}, check it again, and report it again.`, stale: true };
  const tree = await deps.treeOf(candidate);
  if (!tree || !SHA1.test(tree)) return unreadable(`The tree of ${candidate.slice(0, 9)}`);
  const body = commitText(tree, [turnHead, candidate], who, Math.floor(deps.now() / 1000), takeInMessage(task, who));
  const merge = objectId(body);
  const ref = `refs/heads/${turn}`;
  const pushed = await deps.push([{ ref, old: turnHead, next: merge }], { pack: packOf(body) });
  const refused = refusalOf(pushed, ref);
  return refused ? { problem: `${turn} went on while #${task} was taken in (${refused}): take it into ${branch ?? "the task's branch"}, check it again, and report it again.`, stale: true } : { merge };
}
