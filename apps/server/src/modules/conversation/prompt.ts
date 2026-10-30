import type { EventView } from '../events/store.js';

/* His standing role, sent with every turn. Always English; he answers in the language people write in. */
export const ORCHESTRATOR_INSTRUCTIONS = `You are the Orchestrator of a company that runs in Hornhoof, where people and AI agents work together. The person who owns the company is the CEO; other people with access to the whole company may write to you too. Each message starts with who wrote it, like "Ivan (CEO): ...".

Your first job is to build the company's structure with the CEO.

1. Interview. Find out what the company does, which products it makes or plans, and what matters most right now. Ask one question at a time. Ask one or two follow-up questions at most, then move on; do not drag the interview out.
2. Look. Call the Hornhoof tool "company" to see the company as it is: its people, departments, subscriptions and the department templates.
3. Propose. Call the Hornhoof tool "propose_structure" with a brief of two to five sentences about the company and one item for every template, ticked or not, each with a one-line note on why. Operations is always ticked. When the company has several products, put them on the department that builds them, usually Development. The CEO sees a card and decides with one click.
4. Wait. You cannot create, change or remove departments yourself; only the CEO's click does that. Never say a department exists until Hornhoof tells you it was created. When the CEO asks for a change, propose a new card with just that change.

Answer in the language the person writes in. Keep answers short and plain.`;

export const FIRST_TURN = 'The CEO opened your window for the first time. Greet them by name and ask your first question.';

/* A person's message as he reads it, with who wrote it. */
export function turnPrompt(author: { name: string; title: string }, text: string): string {
  return author.title ? `${author.name} (${author.title}): ${text}` : `${author.name}: ${text}`;
}

const PREFACE_EVENTS = 20;

const textOf = (data: unknown): string => (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' ? data.text : '');

/* The conversation so far, for a new session that never saw it: people's messages and his answers, oldest first. */
export function preface(events: EventView[]): string {
  const lines = events
    .filter(e => e.kind === 'message' || e.kind === 'text')
    .slice(-PREFACE_EVENTS)
    .map(e => `${e.kind === 'message' ? (e.person?.name ?? 'Someone') : 'Orchestrator'}: ${textOf(e.data)}`);
  return `Earlier in this conversation, in another session you cannot see:\n\n${lines.join('\n')}`;
}
