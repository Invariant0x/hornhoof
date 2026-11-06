import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { MachineAwayCard } from '../src/types';
import { MachineAway } from '../src/ui/MachineAway';

const AWAY: MachineAwayCard = {
  id: 'm1',
  hostname: 'MacBook Air',
  owner: { id: 'p1', name: 'Lisa' },
  since: '2026-11-06T08:32:00.000Z',
  back: null,
  agents: 11,
  important: [{ name: 'Olaf', kind: 'orchestrator' }, { name: 'Hana', kind: 'head' }],
};

const shown = (machines: MachineAwayCard[]) => render(<LanguageProvider><MachineAway machines={machines} /></LanguageProvider>);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a machine that has gone away, as its people read it', () => {
  it('says which and whose, how many agents, who matters and what to do', () => {
    shown([AWAY]);
    const card = screen.getByRole('region', { name: 'Machine MacBook Air (Lisa) is offline' });
    expect(within(card).getByText(/^Offline since .+\. Agents on it: 11\.$/)).toBeInTheDocument();
    expect(within(card).getByText('Among them: orchestrator Olaf, head Hana.')).toBeInTheDocument();
    expect(within(card).getByText('What to do: switch it on and plug it in, sign in to the account, check that Docker has started.')).toBeInTheDocument();
  });

  it('says the same in Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    shown([AWAY]);
    const card = screen.getByRole('region', { name: 'Машина MacBook Air (Lisa) не на связи' });
    expect(within(card).getByText(/^Не на связи с .+\. Агентов на ней: 11\.$/)).toBeInTheDocument();
    expect(within(card).getByText('Среди них: оркестратор Olaf, руководитель Hana.')).toBeInTheDocument();
    expect(within(card).getByText('Что сделать: включите ее и поставьте на зарядку, войдите в учетную запись, проверьте, что Docker запустился.')).toBeInTheDocument();
  });

  it('names no owner when it has none, and leaves out who matters when nobody on it does', () => {
    shown([{ ...AWAY, owner: null, important: [] }]);
    const card = screen.getByRole('region', { name: 'Machine MacBook Air is offline' });
    expect(within(card).queryByText(/^Among them/)).not.toBeInTheDocument();
  });

  it('shrinks to one line once the machine is back', () => {
    shown([{ ...AWAY, back: '2026-11-06T10:16:00.000Z' }]);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByText(/^Machine MacBook Air is back: .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/What to do/)).not.toBeInTheDocument();
  });

  it('says the line in Russian', () => {
    localStorage.setItem('hh-lang', 'ru');
    shown([{ ...AWAY, back: '2026-11-06T10:16:00.000Z' }]);
    expect(screen.getByText(/^Машина MacBook Air вернулась: .+\.$/)).toBeInTheDocument();
  });
});
