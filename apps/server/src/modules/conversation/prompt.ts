import { NOTIFICATION_NAMES } from '@hornhoof/protocol';
import type { EventView } from '../events/store.js';
import type { MessageEnvelope, MessageParty } from '../events/parties.js';

/* His standing role, sent with every turn: who he is and what the CEO's screen calls the departments. How he works comes
   in his skills, as an employee's does. Always English; he answers in the language people write in. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'You are the Orchestrator of a company that runs in Hornhoof: you run the company with the CEO, who owns it. Your skills below say how you work. ' +
  'Call departments the way the CEO\'s screen does: the template tool gives English names, and in Russian they are Операции, Разработка, Дизайн, Маркетинг, Продажи, Развитие бизнеса, Поддержка, Финансы, Домашние устройства and Домашнее хозяйство.';

export const FIRST_TURN = 'The CEO opened your window for the first time. Greet them by name and ask your first question.';

/* The greeting when the CEO started from a ready-made template: its departments already exist, so skip the interview
   and the structure card and go to staffing. */
export const FIRST_TURN_TEMPLATE =
  'The CEO set the company up from a ready-made template, so its departments already exist. Greet the CEO by name, say in one line that the company started from a template and that you can change its departments any time, call "company" to see them, and offer to staff them one at a time, beginning with the first that has nobody yet. Do not propose a structure card; the departments are already there.';

/* A person's message as he reads it, with who wrote it. */
export function turnPrompt(author: { name: string; title: string }, text: string): string {
  return author.title ? `${author.name} (${author.title}): ${text}` : `${author.name}: ${text}`;
}

/* What someone else wrote, inside a prompt: every line of it is marked, so no line of it passes for Hornhoof's own or for
   another sender's. */
export const quote = (text: string): string =>
  text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');

const PEOPLE = 'People';
const nameOf = (party: MessageParty): string => party.name || PEOPLE;
/* The role, when it says more than the name, and the department. */
const detailsOf = (party: MessageParty): string[] => [party.role?.en !== nameOf(party) ? party.role?.en : null, party.department?.name.en].filter((d): d is string => Boolean(d));
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/* Identity stays on one physical line even when a display name contains whitespace. */
function partyLine(party: MessageParty): string {
  const details = detailsOf(party);
  return oneLine(`${nameOf(party)}${details.length ? ` (${details.join(', ')})` : ''}`);
}

function noticeLine(message: MessageEnvelope): string {
  const notice = message.notification;
  const source = notice ? NOTIFICATION_NAMES[notice.source] : NOTIFICATION_NAMES.service;
  const refs = notice?.tasks.length ? ` on ${notice.tasks.map(t => `#${t.number}`).join(' and ')}` : '';
  const detail = notice?.detail ? ` (${oneLine(notice.detail.en)})` : '';
  return `${source}${refs}${detail}`;
}

export function messageHeading(message: MessageEnvelope): string {
  const senders = message.senders?.length ? message.senders.map(partyLine).join(', ') : partyLine(message.from);
  if (message.from.kind === 'hornhoof') return `From Hornhoof, ${noticeLine(message)} to ${partyLine(message.to)}:`;
  const sender = message.notification ? `${senders} via Hornhoof, ${noticeLine(message)}` : senders;
  return `From ${sender} to ${partyLine(message.to)}:`;
}

/* An attribute's value: Claude Code reads these entities back, and a bare quote or bracket would end the value or the tag. */
const attribute = (text: string): string =>
  oneLine(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* No tag of the message starts or ends inside its text, in any case or spacing an agent may still read as one. */
const tagless = (text: string): string => text.replace(/<(\s*\/?\s*teammate-message)/gi, '&lt;$1');

/* A message as Claude Code shows a teammate's: one line that names the sender, opened with Ctrl+O. The sender's name is
   its teammate_id; the sender's role and what the message is about are its summary. Claude Code shows it so only with
   its agent teams switched on and only for a short paste, so no turn is written this way yet. */
export function teammateMessage(text: string, from: MessageParty, about: string | null): string {
  /* Each part is trimmed before it counts: an attribute of only spaces comes out empty, and Claude Code reads no empty one. */
  const name = oneLine(nameOf(from)) || PEOPLE;
  const details = detailsOf(from).map(oneLine).filter(Boolean).join(', ');
  const summary = [details, oneLine(about ?? '')].filter(Boolean).join(': ') || name;
  return `<teammate-message teammate_id="${attribute(name)}" summary="${attribute(summary)}">\n${tagless(text)}\n</teammate-message>`;
}

/* Applied after history and service instructions are composed, on both queued and live delivery paths. */
export function addressed(text: string, message: MessageEnvelope): string {
  const heading = messageHeading(message);
  return text.startsWith(`${heading}\n`) ? text : `${heading}\n\n${text}`;
}

/* An employee's message to another agent, which reads it as the employee's words, not as orders. */
export function wrote(author: { name: string; title: string }, text: string): string {
  return `${author.title ? `${author.name} (${author.title})` : author.name} wrote:\n\n${quote(text)}`;
}

const PREFACE_EVENTS = 20;
/* The prompt goes to the agent program as one command-line argument, which Linux caps at 128 KiB. */
const PREFACE_BYTES = 48 * 1024;

const textOf = (data: unknown): string => (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' ? data.text : '');

/* Who wrote a message, from what Hornhoof kept about it, never from its text. */
function senderOf(e: EventView, agentName: string): string {
  if (e.kind === 'text') return agentName;
  if (e.person) return e.person.name;
  const data = (e.data ?? {}) as { from?: unknown; name?: unknown };
  if (data.from === 'orchestrator') return 'Orchestrator';
  if (data.from === 'agent' && typeof data.name === 'string') return data.name;
  return 'Hornhoof';
}

/* The conversation so far, for a new session that never saw it: people's and Hornhoof's messages and the agent's answers,
   oldest first, as many of the newest as fit in PREFACE_BYTES. Each one's lines are marked under its sender. */
export function preface(events: EventView[], agentName = 'Orchestrator'): string {
  const lines = events
    .filter(e => e.kind === 'message' || e.kind === 'text')
    .slice(-PREFACE_EVENTS)
    .map(e => `${e.message ? messageHeading(e.message) : `${senderOf(e, agentName)}:`}\n${quote(textOf(e.data))}`);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.reverse()) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > PREFACE_BYTES) break;
    kept.unshift(line);
  }
  return `Earlier in this conversation, in another session you cannot see:\n\n${kept.join('\n')}`;
}
