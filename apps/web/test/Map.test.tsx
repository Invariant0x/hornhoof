import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { chiefStatus, MapScreen } from '../src/screens/Map';
import type { SubView } from '../src/types';
import { mockApi, ORG, ORG_WITH_TEAMS, SUBS } from './api-mock';

const claude = SUBS[0]!;
const STATES: [string, SubView | null, string, string][] = [
  ['none', null, 'Needs a subscription to start', 'Чтобы начать, нужна подписка'],
  ['API key', SUBS[3]!, 'Runs on Anthropic key ending 9f3a', 'Работает на ключе Anthropic, последние символы 9f3a'],
  ['waiting for the machine', { ...claude, status: 'waiting_machine', online: false, machine: null }, "Waiting for Ivan's machine", 'Ждет машину, владелец Ivan'],
  ['needs login', { ...claude, status: 'needs_login' }, 'Waiting for the Claude login', 'Ждет входа в Claude'],
  ['ready and offline', { ...claude, online: false }, "Ivan's machine is offline", 'Машина не в сети, владелец Ivan'],
  ['ready and online', claude, "Runs on Ivan's Claude subscription", 'Работает на подписке Claude, владелец Ivan'],
];

describe('chiefStatus', () => {
  it.each(STATES)('says where the chief runs: %s', (_, sub, english, russian) => {
    expect(chiefStatus(en, sub)).toBe(english);
    expect(chiefStatus(ru, sub)).toBe(russian);
  });
});

describe('Map', () => {
  it('shows the chief, the company people and the empty state on first run', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    render(<MapScreen />);
    expect(await screen.findByText('No departments yet. Ask the chief to create the first one.')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
    expect(screen.getByText('agents working')).toBeInTheDocument();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(screen.getByText('Runs on Anthropic key ending 9f3a')).toBeInTheDocument();
  });

  it('places departments around the chief', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<MapScreen />);
    expect(await screen.findByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.queryByText(/No departments yet/)).not.toBeInTheDocument();
  });

  it('tells when the chief has no subscription', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, chief: { ...ORG.chief, subscription: null } }] });
    render(<MapScreen />);
    expect(await screen.findByText('Needs a subscription to start')).toBeInTheDocument();
  });
});
