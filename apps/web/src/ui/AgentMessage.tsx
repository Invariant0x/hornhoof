import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { EventView, MessageParty } from '../types';

export type AgentMessageView = NonNullable<EventView['message']>;

/* A party as a line names it: the orchestrator and the company's people by a word that fits after "from" and "to" in
   every language, everyone else by name, with the role when it says more than the name. */
export function partyName(t: Messages, language: Language, p: MessageParty): string {
  if (p.kind === 'hornhoof') return t.window.hornhoof;
  if (p.kind === 'agent' && p.agentKind === 'orchestrator') return t.window.theOrchestrator;
  if (p.kind === 'person' && p.id === null) return t.window.people;
  const role = p.role?.[language];
  return role && role.toLocaleLowerCase(language) !== p.name.toLocaleLowerCase(language) ? `${p.name} (${role})` : p.name;
}

/* "Message from … to …" for what came in, "Message to … from …" for what went out, and a notice for what Hornhoof said. */
export function messageLine(t: Messages, language: Language, m: AgentMessageView): string {
  const from = partyName(t, language, m.from);
  const to = partyName(t, language, m.to);
  if (m.direction === 'out') return t.window.messageTo(to, from);
  return m.from.kind === 'hornhoof' ? t.window.notice(to) : t.window.messageFrom(from, to);
}

/* One message as a single line that names who wrote to whom; its whole text, service lines too, opens under it. */
export function AgentMessage({ message, text, open, onToggle }: { message: AgentMessageView; text: string; open: boolean; onToggle(): void }) {
  const t = useT();
  const { language } = useLanguage();
  return (
    <div className={`t-m ${message.direction}`}>
      <button className="t-mh" type="button" aria-expanded={open} onClick={onToggle}>
        <i aria-hidden="true">{open ? '▾' : '▸'}</i>
        <span>{messageLine(t, language, message)}</span>
      </button>
      {open ? <div className="t-mb">{text}</div> : <span className="t-mf">{t.window.folded(text.split('\n').length)}</span>}
    </div>
  );
}
