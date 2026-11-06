import { NOTIFICATION_NAMES, NotificationSchema } from '@hornhoof/protocol';
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
  it.each([
    { language: 'en', t: en, source: 'question', expected: 'Hornhoof, internal question on #223 to Bruno' },
    { language: 'en', t: en, source: 'resolved', expected: 'Hornhoof, internal question resolved on #223 to Bruno' },
    { language: 'ru', t: ru, source: 'question', expected: 'Hornhoof, внутренний вопрос по #223 для Bruno' },
    { language: 'ru', t: ru, source: 'resolved', expected: 'Hornhoof, внутренний вопрос решен по #223 для Bruno' },
  ] as const)('names $language/$source without implying a human answer', ({ language, t, source, expected }) => {
    const received = NotificationSchema.parse({ source, tasks: notification.tasks });
    const message = { direction: 'in', from: service, to: recipient, notification: received } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it.each([['en', en, 'Message from Hana via Hornhoof to Bruno'], ['ru', ru, 'Сообщение от Hana через Hornhoof для Bruno']] as const)('names an actor through Hornhoof in %s', (language, t, expected) => {
    const message = { direction: 'in', from: { ...recipient, id: 'a2', name: 'Hana' }, to: recipient, notification: { source: 'reported', tasks: [] } } satisfies AgentMessageView;
    expect(messageLine(t, language, message)).toBe(expected);
  });
  it('keeps the notice folded under its informative button', () => {
    render(<AgentMessage message={{ direction: 'in', from: service, to: recipient, notification: { ...notification, tasks: [...notification.tasks] } }} text="Continue your work." open={false} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: 'Hornhoof, turn ended before the work on #223 to Bruno' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Continue your work.')).not.toBeInTheDocument();
  });
});
