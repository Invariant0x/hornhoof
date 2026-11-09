import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import type { Briefing } from '../src/types';
import { BriefingPanel } from '../src/ui/Briefing';
import { mockApi } from './api-mock';

const PATH = '/api/departments/p1/briefing';
const KEPT: Briefing = {
  text: 'The shop sells shoes.\nShip on Fridays.',
  repositories: [
    { url: 'https://github.com/acme/shop-design.git', branch: 'main', rules: 'Design files only.', author: { name: 'Ada', email: 'ada@acme.dev' } },
    { url: 'https://github.com/acme/shop.git', branch: 'release', rules: 'Run npm test first.', author: null },
  ],
  connected: { url: 'https://github.com/acme/shop.git', branch: 'release', author: { name: 'Ivan Korol', email: 'ivan@acme.dev' } },
  updatedAt: '2026-11-09T12:00:00.000Z',
  by: { name: 'Maria', byOrchestrator: false },
};

function shown(language: 'en' | 'ru', briefing: Briefing, save: [number, unknown] = [200, { briefing }]) {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi({ [`GET ${PATH}`]: [200, { briefing }], [`PUT ${PATH}`]: save });
  render(<LanguageProvider><BriefingPanel placeId="p1" /></LanguageProvider>);
  return calls;
}

describe("what a product keeps for its agents, on the department's screen", () => {
  it.each([
    ['en', 'Repositories', 'Cloned for the agents, branch release', 'Last changed by Maria', 'Change'],
    ['ru', 'Репозитории', 'Клонируется агентам, ветка release', 'Последним менял(а) Maria', 'Изменить'],
  ] as const)('shows how they work and every repository, the cloned one first, in %s', async (language, list, cloned, by, change) => {
    shown(language, KEPT);
    expect(await screen.findByText(/The shop sells shoes\./)).toBeInTheDocument();
    const repos = within(screen.getByRole('list', { name: list })).getAllByRole('listitem');
    expect(repos.map(r => r.querySelector('.repo-url')?.textContent)).toEqual(['https://github.com/acme/shop.git', 'https://github.com/acme/shop-design.git']);
    expect(repos[0]).toHaveTextContent(cloned);
    expect(repos[0]).toHaveTextContent('Run npm test first.');
    expect(repos[1]).toHaveTextContent('Design files only.');
    expect(screen.getByText(by)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: change })).toBeInTheDocument();
  });

  it('says when nothing is written yet', async () => {
    shown('en', { text: '', repositories: [], connected: null, updatedAt: null, by: null });
    expect(await screen.findByText('Nothing written yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('saves how they work and the repositories as people changed them', async () => {
    const calls = shown('en', KEPT);
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    const text = screen.getByLabelText('How you work');
    await userEvent.clear(text);
    await userEvent.type(text, 'Ship on Mondays.');
    await userEvent.click(within(screen.getByRole('group', { name: 'Repository 1' })).getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Repository' }));
    const added = within(screen.getByRole('group', { name: 'Repository 2' }));
    await userEvent.type(added.getByLabelText('Address'), 'https://github.com/acme/shop-docs.git');
    await userEvent.type(added.getByLabelText('Its rules'), 'Plain English.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.filter(c => c.method === 'PUT').map(c => c.body)).toEqual([{
      text: 'Ship on Mondays.',
      repositories: [
        { url: 'https://github.com/acme/shop.git', branch: 'release', rules: 'Run npm test first.', author: null },
        { url: 'https://github.com/acme/shop-docs.git', branch: 'main', rules: 'Plain English.', author: null },
      ],
    }]);
  });

  it('keeps the form open with the reason when the change is refused', async () => {
    shown('ru', KEPT, [403, { error: { code: 'forbidden', message: 'Only people with access to this department or the whole company can read and change what it keeps for its agents.', reason: 'not_your_department' } }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Как вы работаете')).toBeInTheDocument();
  });
});
