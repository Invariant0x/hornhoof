import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Me } from '../src/types';
import { ME, mockApi, ORG } from './api-mock';
import { fakeStream } from './fake-stream';

const LISTED_ME: Me = {
  person: { id: 'p3', companyId: 'c1', name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', status: 'active', scopeKind: 'listed', isOwner: false },
  company: { id: 'c1', name: 'Acme' },
};

const PAUSED_AT = '2026-11-21T10:15:00.000Z';
const PAUSED = { by: 'p1', byName: 'Ivan', at: PAUSED_AT };

afterEach(() => {
  localStorage.clear();
});

describe('Company pause in Shell', () => {
  it('places Pause company next to Talk to the orchestrator, shows finishing count live via SSE, and resumes on click', async () => {
    const stream = fakeStream();
    let paused: typeof PAUSED | null = null;
    let finishingTurns = 2;
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/company/pause': () => [200, { paused, finishingTurns }],
      'POST /api/company/pause': () => {
        paused = PAUSED;
        return [200, { paused, finishingTurns }];
      },
      'POST /api/company/resume': () => {
        paused = null;
        finishingTurns = 0;
        return [200, { paused: null, finishingTurns: 0 }];
      },
    });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    /* Open account menu: Pause company sits right next to Talk to the orchestrator. */
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const menu = document.querySelector('.account-menu') as HTMLElement;
    const rows = within(menu).getAllByRole('button').map(b => b.textContent);
    const contactIdx = rows.indexOf('Talk to the orchestrator');
    expect(contactIdx).toBeGreaterThanOrEqual(0);
    expect(rows[contactIdx + 1]).toBe('Pause company');

    /* Pause the company. */
    await user.click(within(menu).getByRole('button', { name: 'Pause company' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/company/pause')).toBe(true);
    const banner = await screen.findByRole('status', { name: 'Company pause' });
    expect(banner).toHaveTextContent(/The company is paused\./);
    expect(banner).toHaveTextContent(/2 turns are still finishing\./);
    expect(banner).toHaveTextContent(/Ivan/);
    expect(within(banner).getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    /* Live SSE working event updates finishing count down to 1 and then 0 ("Nothing is running"). */
    stream.send({ type: 'working', working: 1 });
    expect(banner).toHaveTextContent(/1 turn is still finishing\./);

    stream.send({ type: 'working', working: 0 });
    expect(banner).toHaveTextContent(/Nothing is running\./);

    /* Account menu now offers Resume company. */
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const openMenu = document.querySelector('.account-menu') as HTMLElement;
    expect(within(openMenu).getByRole('button', { name: 'Resume company' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    /* Resume from the banner hides the banner. */
    await user.click(within(banner).getByRole('button', { name: 'Resume' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/company/resume')).toBe(true);
    expect(screen.queryByRole('status', { name: 'Company pause' })).not.toBeInTheDocument();
  });

  it('shows the pause banner without Pause or Resume controls to a listed-scope person', async () => {
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/company/pause': [200, { paused: PAUSED, finishingTurns: 1 }],
    });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={LISTED_ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    const banner = await screen.findByRole('status', { name: 'Company pause' });
    expect(banner).toHaveTextContent(/The company is paused\./);
    expect(banner).toHaveTextContent(/1 turn is still finishing\./);
    expect(banner).toHaveTextContent(/Ivan/);
    expect(within(banner).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account' }));
    const menu = document.querySelector('.account-menu') as HTMLElement;
    expect(within(menu).queryByRole('button', { name: 'Pause company' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Resume company' })).not.toBeInTheDocument();
  });

  it('renders Russian copy with plural forms and surfaces resume failure', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const stream = fakeStream();
    mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/company/pause': [200, { paused: PAUSED, finishingTurns: 5 }],
      'POST /api/company/resume': [403, { error: { code: 'forbidden', reason: 'company_resume_forbidden', message: 'Forbidden' } }],
    });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    const banner = await screen.findByRole('status', { name: 'Пауза компании' });
    expect(banner).toHaveTextContent(/Компания на паузе\./);
    expect(banner).toHaveTextContent(/5 ходов/);

    stream.send({ type: 'working', working: 2 });
    expect(banner).toHaveTextContent(/2 хода/);

    stream.send({ type: 'working', working: 0 });
    expect(banner).toHaveTextContent(/Ничего не запущено/);

    await user.click(within(banner).getByRole('button', { name: 'Пуск' }));
    expect(await within(banner).findByRole('alert')).toBeInTheDocument();
  });
});
