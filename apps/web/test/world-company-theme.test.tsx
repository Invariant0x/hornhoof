/* Stage 7 web tests: personal theme selection removed from Appearance & language;
   one company-wide theme chosen by the CEO in Company & access and synced to every member. */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { initSkins, skinsState } from '../src/skins/store';
import { ME, mockApi, ORG } from './api-mock';

const root = document.documentElement;

function clearPage() {
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.cut;
  delete root.dataset.world;
  delete root.dataset.surface;
  delete root.dataset.grain;
  root.removeAttribute('style');
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  clearPage();
  initSkins();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
  clearPage();
  initSkins();
});

describe('Stage 7 company-wide theme in Company & access (no personal theme picker)', () => {
  it('removes personal theme selection from Appearance & language for both CEO and non-CEO users', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/org': [200, { ...ORG, company: { ...ORG.company, theme: 'cyberpunk' } }],
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
    });
    const nonCeoWhole = { ...ME.person, id: 'p2', name: 'Maria', scopeKind: 'company' as const, isOwner: false };
    render(
      <LanguageProvider>
        <Shell me={{ ...ME, person: nonCeoWhole, company: { ...ME.company, theme: 'cyberpunk' } }} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });

    await user.click(within(dialog).getByRole('button', { name: 'Appearance & language' }));
    expect(within(dialog).getByRole('combobox', { name: 'Language' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: 'Theme catalog' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Theme store' })).not.toBeInTheDocument();

    /* Whole-company non-owner sees Company & access for the public link, but NOT the CEO theme store. */
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    expect(within(dialog).queryByRole('region', { name: 'Theme catalog' })).not.toBeInTheDocument();
  });

  it('lets the CEO switch the company theme in Company & access via PUT /api/world/theme', async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      'GET /api/org': [200, { ...ORG, company: { ...ORG.company, theme: 'cyberpunk' } }],
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'PUT /api/world/theme': body => [200, { theme: (body as { theme: string }).theme, activePack: null, canEdit: true }],
    });
    render(
      <LanguageProvider>
        <Shell me={{ ...ME, company: { ...ME.company, theme: 'cyberpunk' } }} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });

    /* Even the CEO has no theme catalog under personal Appearance & language. */
    await user.click(within(dialog).getByRole('button', { name: 'Appearance & language' }));
    expect(within(dialog).queryByRole('region', { name: 'Theme catalog' })).not.toBeInTheDocument();

    /* Company theme lives in Company & access for the CEO. */
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    expect(within(dialog).getByRole('region', { name: 'Theme catalog' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Apply: Ancient Egypt' }));
    await waitFor(() => expect(root.dataset.theme).toBe('egypt'));
    expect(root.dataset.world).toBe('egypt');
    expect(calls.filter(c => c.method === 'PUT' && c.path === '/api/world/theme')).toEqual([
      { method: 'PUT', path: '/api/world/theme', body: { theme: 'egypt' } },
    ]);
  });

  it('syncs every signed-in member to the company theme from the server and ignores stale personal localStorage theme', async () => {
    localStorage.setItem('hh-theme', 'egypt');
    initSkins();
    expect(skinsState().active).toBe('egypt');

    mockApi({ 'GET /api/org': [200, { ...ORG, company: { ...ORG.company, theme: 'cyberpunk' } }] });
    const listed = { ...ME.person, id: 'p3', name: 'Ann', scopeKind: 'listed' as const, isOwner: false };
    render(
      <LanguageProvider>
        <Shell me={{ ...ME, person: listed, company: { ...ME.company, theme: 'cyberpunk' } }} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    await waitFor(() => expect(root.dataset.theme).toBe('cyberpunk'));
    expect(root.dataset.world).toBeUndefined();
    expect(skinsState().active).toBe('cyberpunk');
  });

  it('keeps the previous theme and shows an alert if PUT /api/world/theme fails', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/org': [200, { ...ORG, company: { ...ORG.company, theme: 'cyberpunk' } }],
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'PUT /api/world/theme': [403, { error: { code: 'forbidden', message: 'Only the CEO can change the company theme.' } }],
    });
    render(
      <LanguageProvider>
        <Shell me={{ ...ME, company: { ...ME.company, theme: 'cyberpunk' } }} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Ancient Egypt' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only the CEO can change the company theme.');
    expect(root.dataset.theme).toBe('cyberpunk');
  });
});
