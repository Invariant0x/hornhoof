import { localeInfo, NOTIFICATION_NAMES } from '@hornhoof/protocol';
import type { EventView } from '../events/store.js';
import type { MessageEnvelope, MessageParty } from '../events/parties.js';
import type { BotLang } from '../telegram/words.js';

/* Standing identity; company procedures arrive through selected abilities. Nothing is hidden from him and he may do
   anything, his own system included (Ivan's word of 17 November 2026). */
export const ORCHESTRATOR_INSTRUCTIONS =
  'You are the Orchestrator who runs the company with its CEO, can do anything in the company and in Hornhoof itself, sees everything and can change its own system.';

export const FIRST_TURN = 'The CEO opened your window for the first time. Greet them by name and ask your first question.';
export const FIRST_CONTACT_ACTION = 'first_contact';

/* The template has at least one employee in each department. */
export const FIRST_TURN_STAFFED =
  'Greet the CEO by name. The template created departments with employees. Check required roles, who is active and which plans and machines can run the requested work before calling the company ready. Use company and staffing_options for the current setup. Address gaps that affect the requested work.';

/* The greeting for a company started from a template before templates brought their people: its departments already
   exist, so skip the interview and the structure card and go to staffing. */
export const FIRST_TURN_TEMPLATE =
  'The CEO set the company up from a ready-made template, so its departments already exist. Greet the CEO by name, say in one line that the company started from a template and that you can change its departments any time, call "company" to see them, and offer to staff them one at a time, beginning with the first that has nobody yet. Do not propose a structure card; the departments are already there.';

/* The machine a person sits at when they write, and until when its computer access is open. */
export type WrittenFrom = { machine: string; open: boolean };

/* A person's message as he reads it, with who wrote it. When they write from a machine of the company, one line before
   it says which, so he knows where the person sits and whether that machine is open to him. */
export function turnPrompt(author: { name: string; title: string }, text: string, from?: WrittenFrom): string {
  const said = author.title ? `${author.name} (${author.title}): ${text}` : `${author.name}: ${text}`;
  if (!from) return said;
  return `${author.name} writes this from ${from.machine}; access to it is ${from.open ? 'open' : 'closed by its owner'}.\n${said}`;
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

/* The sender, with the way a person's message came when not from the agent's window. */
function channelLine(message: MessageEnvelope, senders: string): string {
  if (message.channel === 'telegram') return `${senders} via Telegram`;
  if (message.channel === 'assistant') return `${senders} through the assistant ${oneLine(message.assistant?.name ?? '')}`.trimEnd();
  return senders;
}

export function messageHeading(message: MessageEnvelope): string {
  const senders = message.senders?.length ? message.senders.map(partyLine).join(', ') : partyLine(message.from);
  if (message.from.kind === 'hornhoof') return `From Hornhoof, ${noticeLine(message)} to ${partyLine(message.to)}:`;
  const sender = message.notification ? `${senders} via Hornhoof, ${noticeLine(message)}` : channelLine(message, senders);
  return `From ${sender} to ${partyLine(message.to)}:`;
}

/* Applied after history and service instructions are composed, on both queued and live delivery paths. */
export function addressed(text: string, message: MessageEnvelope): string {
  const heading = messageHeading(message);
  return text.startsWith(`${heading}\n`) ? text : `${heading}\n\n${text}`;
}

/* What a person is in the company, as far as it weighs their words: its owner, the CEO's delegate, the person responsible
   for the agent's department. department is null for an agent outside any department. */
export type Standing = { owner: boolean; delegate: boolean; department: boolean | null };

/* What the person is in the company, in one sentence. */
export function whoIs(author: { name: string }, standing: Standing): string {
  const is = [standing.owner && "the company's owner (the CEO)", standing.delegate && "the CEO's delegate", standing.department && 'responsible for your department'].filter(Boolean);
  return is.length
    ? `${author.name} is ${is.join(' and ')}.`
    : `${author.name} is neither the company's owner nor the CEO's delegate${standing.department === false ? ', nor responsible for your department' : ''}.`;
}

/* Below a person's message that came through the agent's Telegram bot: who they are, and where the answer goes. */
export function answerInTelegram(author: { name: string }, standing: Standing, lang: BotLang): string {
  const language = localeInfo(lang)?.english ?? 'English';
  return [
    `This is ${author.name} writing to you directly in Telegram. ${whoIs(author, standing)}`,
    `Your last message of this turn goes to ${author.name} as your answer. Use the language of their own words. Write it directly to them in ${language} when their message does not establish a language. Keep it short and use plain text. Do not narrate your steps to them.`,
    `Write task titles, briefs and questions for ${author.name} in ${language}.`,
    `Files you attach to the chat in this turn with hh-attach --chat FILE go to their Telegram chat as documents too.`,
    `This answer goes to ${author.name} alone. Answer their own words here. Answer other people in their own turns.`,
  ].join(' ');
}

/* Below a message that a person's assistant wrote for them: whose words they are, what the person is, where the answer
   goes and how a file goes with it. The words weigh as the person's own. */
export function answerForAssistant(owner: { name: string }, assistant: { name: string }, standing: Standing): string {
  return [
    `${assistant.name} is the personal assistant of ${owner.name} and wrote this for ${owner.name}, at their request. ${whoIs(owner, standing)}`,
    `Take these words as ${owner.name}'s own. Your answer in this window goes back to ${assistant.name} for ${owner.name} to read: write it as one person to another, in the language of these words, as plain text without formatting, and with no ids or codes ${owner.name} did not ask for.`,
    `To give ${owner.name} a file, attach it with hh-attach --chat FILE: it goes with your answer.`,
  ].join(' ');
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
