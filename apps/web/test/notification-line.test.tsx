import { NOTIFICATION_NAMES } from '@hornhoof/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { AgentMessage, messageLine, type AgentMessageView } from '../src/ui/AgentMessage';

const service = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null } as const;
const recipient = { kind: 'agent', id: 'a1', name: 'Bruno', role: null, department: null } as const;
const notification = { source: 'go_on', tasks: [{ id: 't1', number: 223 }] } as const;

describe('notification lines', () => {
  it.each(Object.keys(NOTIFICATION_NAMES))('has both names for %s', source => {
    expect(en.notificationSources).toHaveProperty(source, expect.stringMatching(/\S/));
    expect(ru.notificationSources).toHaveProperty(source, expect.stringMatching(/\S/));
  });
  it.each([
    ['en', en, 'Hornhoof, turn ended before the work on #223 to Bruno'],
    ['ru', ru, 'Hornhoof, ход закончился раньше работы по #223 для Bruno'],
  ] as const)('shows the source and cause in %s', (language, t, expected) => {
    const message = { direction: 'in', from: service, to: recipient, notification: { ...notification, tasks: [...notification.tasks] } } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it.each([['en', en, 'Message from Hana via Hornhoof to Bruno'], ['ru', ru, 'Сообщение от Hana через Hornhoof для Bruno']] as const)('names an actor through Hornhoof in %s', (language, t, expected) => {
    const message = { direction: 'in', from: { ...recipient, id: 'a2', name: 'Hana' }, to: recipient, notification: { source: 'reported', tasks: [] } } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it.each([['en', en, 'Message from Ivan via Telegram to Bruno'], ['ru', ru, 'Сообщение от Ivan через Telegram для Bruno']] as const)('says a person wrote through Telegram in %s', (language, t, expected) => {
    const message = { direction: 'in', from: { kind: 'person', id: 'p1', name: 'Ivan', role: null, department: null }, to: recipient, channel: 'telegram' } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it.each([['en', en, 'Message from Ivan through the assistant Ava to Bruno'], ['ru', ru, 'Сообщение от Ivan через ассистента Ava для Bruno']] as const)('says a person wrote through their assistant in %s', (language, t, expected) => {
    const message = { direction: 'in', from: { kind: 'person', id: 'p1', name: 'Ivan', role: null, department: null }, to: recipient, channel: 'assistant', assistant: { id: 'h1', name: 'Ava' } } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it('keeps the notice folded under its informative button', () => {
    render(<AgentMessage message={{ direction: 'in', from: service, to: recipient, notification: { ...notification, tasks: [...notification.tasks] } }} text="Continue your work." open={false} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: 'Hornhoof, turn ended before the work on #223 to Bruno' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Continue your work.')).not.toBeInTheDocument();
  });
});
