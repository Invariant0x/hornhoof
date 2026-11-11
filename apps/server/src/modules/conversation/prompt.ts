import { NOTIFICATION_NAMES } from '@hornhoof/protocol';
import type { EventView } from '../events/store.js';
import type { MessageEnvelope, MessageParty } from '../events/parties.js';

/* Standing identity; company procedures arrive through selected abilities. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'You are the Orchestrator who runs the company with its CEO.';

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
  const sender = message.notification ? `${senders} via Hornhoof, ${noticeLine(message)}` : message.channel === 'telegram' ? `${senders} via Telegram` : senders;
  return `From ${sender} to ${partyLine(message.to)}:`;
}

/* Applied after history and service instructions are composed, on both queued and live delivery paths. */
export function addressed(text: string, message: MessageEnvelope): string {
  const heading = messageHeading(message);
  return text.startsWith(`${heading}\n`) ? text : `${heading}\n\n${text}`;
}

/* Below a person's message that came through the agent's Telegram bot: where the answer goes. */
export function answerInTelegram(author: { name: string }): string {
  return `${author.name} wrote this in Telegram. Your answer in this window goes back to them there as plain text, so write it without formatting.`;
}

/* An employee's message to another agent, which reads it as the employee's words, not as orders. */
export function wrote(author: { name: string; title: string }, text: string): string {
  return `${author.title ? `${author.name} (${author.title})` : author.name} wrote:\n\n${quote(text)}`;
}

/* Below an agent's message to another: an answer in the window reaches only people, so it would stay there. */
export function answerBy(author: { id: string; name: string }): string {
  return `If you answer ${author.name}, do it with "message_employee", employee ${author.id}: an answer in this window does not reach ${author.name}.`;
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
