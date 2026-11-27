/* What a person's words, written to an agent directly, say of the question they answer. Words close a question of the agent's
   by themselves only when it is clear which: the only one that person may answer, or the one the words point at. Otherwise
   the agent says which, citing the words (record_answer). */

/* The words as a person reads them: spaces and line breaks count as one space. */
export const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* An open question as far as the words can point at it: its task, by id and number, and its own words. */
export type Pointed = { taskId: string; number: number; text: string };

type Pointers = { refs: Set<string>; quoted: string[] };

/* The task given with the words, the tasks they name (#12) or link (…/tasks/<id>), and the lines they quote ("> …"). Anyone
   who may write to the agent sends these words, of any length: every pattern stays within one line, so reading them takes
   time in step with their length. */
function pointersOf(said: string, task: number | string | undefined): Pointers {
  const refs = new Set<string>();
  if (task !== undefined) refs.add(String(task).replace(/^#/, '').toLowerCase());
  for (const [, n] of said.matchAll(/#(\d+)\b/g)) refs.add(n!);
  for (const [, ref] of said.matchAll(/\/tasks\/([0-9a-f-]{36}|\d+)/gi)) refs.add(ref!.toLowerCase());
  const quoted = new Set([...said.matchAll(/^[ \t]*>[ \t]?(.+)$/gm)].map(([, line]) => flat(line!)).filter(Boolean));
  return { refs, quoted: [...quoted] };
}

function pointsAt(q: Pointed, { refs, quoted }: Pointers): boolean {
  if (refs.has(String(q.number)) || refs.has(q.taskId)) return true;
  const text = flat(q.text);
  return quoted.some(line => text.includes(line));
}

/* Of the open questions a person may answer, the one their words answer by themselves: the only one, or the only one they
   point at. None when it is not clear which. */
export function clearlyAnswered<Q extends Pointed>(open: readonly Q[], said: string, task?: number | string, original?: string): Q[] {
  const candidates = original === undefined ? open : open.filter(q => replyMatches(q, original));
  const pointers = pointersOf(said, task);
  if (!pointers.refs.size && !pointers.quoted.length && candidates.length <= 1) return [...candidates];
  const at = candidates.filter(q => pointsAt(q, pointers));
  return at.length === 1 ? at : [];
}

/* A reply points to a single task by number or link, or quotes the complete question. */
export function replyMatches(q: Pointed, original: string): boolean {
  const { refs } = pointersOf(original, undefined);
  if (refs.size) return [...refs].every(ref => ref === String(q.number) || ref === q.taskId);
  return Boolean(q.text.trim()) && flat(original).includes(flat(q.text));
}

export function canCiteFor(data: unknown, question: Pointed): boolean {
  const reply = (data as { telegram?: { reply?: { text: string } } } | null)?.telegram?.reply;
  return !reply || replyMatches(question, reply.text);
}

/* Whether a message holds these words, spaces aside. */
export const holds = (message: string, words: string): boolean => flat(message).includes(flat(words));
