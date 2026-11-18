import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Settings } from '../src/screens/Settings';
import type { RepoHost } from '../src/types';
import { Repositories } from '../src/ui/RepoSettings';
import { ME, mockApi } from './api-mock';

/* The GitHub key Hornhoof creates repositories with: the whole company's in Settings, a department's own on its screen. */

const KEY = { provider: 'github', owner: 'acme', tokenLast4: '1111' } as const;
const LINK: Parameters<typeof mockApi>[0] = { 'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }] };

/* The company's key is a card of Integrations, beside Google Sheets. */
async function settings(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ ...LINK, 'GET /api/google-sheets': [200, { google: null }], ...routes });
  render(<Settings me={ME} group="integrations" onClose={() => {}} />);
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  return { calls, dialog, part: await within(dialog).findByRole('article', { name: 'Creating repositories' }) };
}

function department(repoHost: RepoHost | null, routes: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi(routes);
  render(
    <LanguageProvider>
      <Repositories department={{ id: 'd2', repository: null, products: [], repoHost }} />
    </LanguageProvider>,
  );
  return { calls, part: screen.getByRole('region', { name: 'Creating repositories' }) };
}

describe("the company's key in Settings, under Integrations", () => {
  it('stands as a card after Google Sheets, connected once a key is saved, and no longer under Company & access', async () => {
    const { dialog, part } = await settings({ 'GET /api/repo-host': [200, { host: null }] });
    expect(within(dialog).getAllByRole('article').map(card => within(card).getByRole('heading').textContent)).toEqual(['Google Sheets', 'Creating repositories']);
    expect(within(part).getByText('Not connected')).toBeInTheDocument();
    cleanup();
    const again = await settings({ 'GET /api/repo-host': [200, { host: KEY }] });
    expect(within(again.part).getByText('Connected')).toBeInTheDocument();
    cleanup();
    mockApi({ ...LINK, 'GET /api/repo-host': [200, { host: KEY }], 'GET /api/backups': [200, { last: null, recovery: null, recoveryNeeded: false, linkChanged: false, restore: null, kept: [], bundles: [] }] });
    render(<Settings me={ME} group="company" onClose={() => {}} />);
    const company = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(company).findByRole('heading', { name: 'Backups' })).toBeInTheDocument();
    expect(within(company).queryByRole('heading', { name: 'Creating repositories' })).not.toBeInTheDocument();
  });

  it('is not there for a person the server does not give the key', async () => {
    mockApi({ ...LINK, 'GET /api/google-sheets': [200, { google: null }], 'GET /api/repo-host': [403, { error: { code: 'forbidden', message: 'Forbidden.' } }] });
    render(<Settings me={ME} group="integrations" onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(dialog).findByRole('article', { name: 'Google Sheets' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('article').map(card => within(card).getByRole('heading').textContent)).toEqual(['Google Sheets']);
  });

  it('says what it is for when none is saved, and saves the owner and the key', async () => {
    const user = userEvent.setup();
    const { calls, part } = await settings({
      'GET /api/repo-host': [200, { host: null }],
      'PUT /api/repo-host': [200, { host: KEY }],
    });
    expect(part).toHaveTextContent('No GitHub key is saved, so the orchestrator cannot create repositories.');
    expect(part).toHaveTextContent('With a GitHub key saved here, the orchestrator itself creates a private repository for each department that has none yet, and tells you about it.');
    await user.click(within(part).getByRole('button', { name: 'Save a key' }));
    expect(within(part).getByLabelText('GitHub owner')).toHaveAccessibleDescription('The user or organization the repositories go to, as in github.com/acme.');
    expect(within(part).getByLabelText('Key')).toHaveAccessibleDescription(expect.stringContaining('Administration and Contents'));
    /* A masked text field, so no browser fills the person's Hornhoof sign-in into it (#1320). */
    expect(within(part).getByLabelText('Key')).toHaveAttribute('type', 'text');
    expect(within(part).getByLabelText('Key')).toHaveClass('secret-masked');
    await user.type(within(part).getByLabelText('GitHub owner'), ' acme ');
    await user.type(within(part).getByLabelText('Key'), 'ghp_x1111');
    await user.click(within(part).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(part).toHaveTextContent('The orchestrator creates repositories on GitHub for acme, with the key ending in 1111.'));
    expect(within(part).getByText('acme', { selector: 'bdi.ident' })).toBeInTheDocument();
    expect(within(part).getByText('Connected')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/repo-host', body: { owner: 'acme', token: 'ghp_x1111' } });
  });

  it('keeps the saved key when only the owner changes, and removes it after asking', async () => {
    const user = userEvent.setup();
    const { calls, part } = await settings({
      'GET /api/repo-host': [200, { host: KEY }],
      'PUT /api/repo-host': [200, { host: { ...KEY, owner: 'acme-labs' } }],
      'DELETE /api/repo-host': [204],
    });
    await user.click(await within(part).findByRole('button', { name: 'Change key' }));
    expect(within(part).getByLabelText('GitHub owner')).toHaveValue('acme');
    expect(within(part).getByLabelText('Key')).toHaveAccessibleDescription('Leave it empty to keep the saved key.');
    await user.clear(within(part).getByLabelText('GitHub owner'));
    await user.type(within(part).getByLabelText('GitHub owner'), 'acme-labs');
    await user.click(within(part).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(part).toHaveTextContent(/for acme-labs, with the key ending in 1111/));
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ owner: 'acme-labs' });

    await user.click(within(part).getByRole('button', { name: 'Remove key' }));
    expect(within(part).getByText('Hornhoof stops creating repositories with this key. The repositories it created keep working.')).toBeInTheDocument();
    await user.click(within(part).getByRole('button', { name: 'Remove' }));
    expect(await within(part).findByText(/No GitHub key is saved/)).toBeInTheDocument();
    expect(calls.map(c => `${c.method} ${c.path}`)).toContain('DELETE /api/repo-host');
  });

  it('makes Save a key the main button of a record with no key, and Remove key the pink one, last of its row', async () => {
    const { part } = await settings({ 'GET /api/repo-host': [200, { host: null }] });
    const first = await within(part).findByRole('button', { name: 'Save a key' });
    expect(first).toHaveClass('btn');
    expect(first).not.toHaveClass('ghost');
    cleanup();
    const again = await settings({ 'GET /api/repo-host': [200, { host: KEY }] });
    const remove = await within(again.part).findByRole('button', { name: 'Remove key' });
    expect(remove).toHaveClass('btn', 'ghost', 'danger');
    expect(remove.parentElement!.lastElementChild).toBe(remove);
    expect(within(again.part).getByRole('button', { name: 'Change key' })).not.toHaveClass('danger');
  });

  it("says the server's refusal in plain words", async () => {
    const user = userEvent.setup();
    const { part } = await settings({
      'GET /api/repo-host': [200, { host: null }],
      'PUT /api/repo-host': [400, { error: { code: 'validation', message: 'x', reason: 'repo_host_invalid' } }],
    });
    await user.click(within(part).getByRole('button', { name: 'Save a key' }));
    await user.type(within(part).getByLabelText('GitHub owner'), 'acme/shop');
    await user.type(within(part).getByLabelText('Key'), 'ghp_x1111');
    await user.click(within(part).getByRole('button', { name: 'Save' }));
    expect(await within(part).findByRole('alert')).toHaveTextContent(en.errors.repo_host_invalid);
  });
});

describe("a department's key on its screen", () => {
  it("names the company's key it uses, and saves one of its own", async () => {
    const user = userEvent.setup();
    const { calls, part } = department({ ...KEY, own: false }, { 'PUT /api/departments/d2/repo-host': [200, { host: { ...KEY, owner: 'acme-dev', tokenLast4: '2222' } }] });
    expect(part).toHaveTextContent("The orchestrator creates this department's repositories on GitHub for acme, with the company's key.");
    await user.click(within(part).getByRole('button', { name: 'Use a key of its own' }));
    await user.type(within(part).getByLabelText('GitHub owner'), 'acme-dev');
    await user.type(within(part).getByLabelText('Key'), 'github_pat_2222');
    await user.click(within(part).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/departments/d2/repo-host', body: { owner: 'acme-dev', token: 'github_pat_2222' } }));
  });

  it('shows its own key with its ending, and removes it after asking', async () => {
    const user = userEvent.setup();
    const { calls, part } = department({ ...KEY, owner: 'acme-dev', tokenLast4: '2222', own: true }, { 'DELETE /api/departments/d2/repo-host': [204] });
    expect(part).toHaveTextContent("The orchestrator creates this department's repositories on GitHub for acme-dev, with its own key ending in 2222.");
    await user.click(within(part).getByRole('button', { name: 'Remove key' }));
    await user.click(within(part).getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(calls.map(c => `${c.method} ${c.path}`)).toContain('DELETE /api/departments/d2/repo-host'));
  });

  it('says where a key can be saved when there is none', () => {
    const { part } = department(null);
    expect(part).toHaveTextContent('No GitHub key is saved, so the orchestrator cannot create a repository for this department. Save one here, or the CEO saves one for the whole company in Settings, under Integrations.');
    expect(within(part).getByRole('button', { name: 'Save a key' })).toBeInTheDocument();
  });
});

describe('the words of the keys', () => {
  it('has every text in Russian too, with no long dash and no letter ё', () => {
    for (const t of [en, ru]) {
      const words = JSON.stringify([t.repoHost, t.errors.repo_host_invalid, t.errors.repo_host_on_product, t.errors.repo_host_missing, t.errors.repo_host_refused, t.errors.repo_name_invalid, t.errors.repo_exists, t.settings.title, t.settings.menu]);
      expect(words).not.toMatch(/[—ё]/);
    }
    expect(Object.keys(ru.repoHost).sort()).toEqual(Object.keys(en.repoHost).sort());
    expect(ru.settings.title).toBe('Настройки');
    expect(ru.settings.groups.company).toBe('Компания и доступ');
    expect(ru.repoHost.about).toMatch(/оркестратор сам создает закрытый репозиторий каждому отделу, у которого его еще нет, и сообщает об этом/);
  });
});
