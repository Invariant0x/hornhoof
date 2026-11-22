/* Stage 7 web tests: personal theme selection removed from Appearance & language;
   one company-wide theme chosen by the CEO in Company & access and synced to every member. */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { initSkins, skinsState } from '../src/skins/store';
import { WorldAgentQuickChat } from '../src/ui/WorldAgentQuickChat';
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

  it('lets the CEO preview, confirm bulk era renaming, and restore original agent names from Company & access', async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      'GET /api/org': [200, { ...ORG, company: { ...ORG.company, theme: 'egypt' } }],
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/world/theme': [200, { theme: 'egypt', activePack: { id: 'egypt', label: { en: 'Ancient Egypt', ru: 'Древний Египет' }, skillIds: ['world-egypt-voice'] }, canEdit: true, renamedAgentsCount: 0 }],
      'GET /api/world/rename-preview?lang=en': [
        200,
        {
          packId: 'egypt',
          packLabel: { en: 'Ancient Egypt', ru: 'Древний Египет' },
          lang: 'en',
          alreadyRenamedCount: 0,
          items: [
            { agentId: 'a1', kind: 'orchestrator', currentName: 'Orchestrator', proposedName: 'Pharaoh Khufu', preservedOriginalName: 'Orchestrator' },
            { agentId: 'b1', kind: 'worker', currentName: 'Tank', proposedName: 'Imhotep', preservedOriginalName: 'Tank' },
          ],
        },
      ],
      'POST /api/world/rename-agents': [
        200,
        {
          packId: 'egypt',
          lang: 'en',
          renamedCount: 2,
          items: [
            { agentId: 'a1', kind: 'orchestrator', currentName: 'Orchestrator', proposedName: 'Pharaoh Khufu', preservedOriginalName: 'Orchestrator' },
            { agentId: 'b1', kind: 'worker', currentName: 'Tank', proposedName: 'Imhotep', preservedOriginalName: 'Tank' },
          ],
        },
      ],
      'POST /api/world/restore-names': [
        200,
        {
          restoredCount: 2,
          items: [
            { agentId: 'a1', previousName: 'Pharaoh Khufu', restoredName: 'Orchestrator' },
            { agentId: 'b1', previousName: 'Imhotep', restoredName: 'Tank' },
          ],
        },
      ],
    });

    render(
      <LanguageProvider>
        <Shell me={{ ...ME, company: { ...ME.company, theme: 'egypt' } }} onSignOut={() => {}} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const settingsDialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(settingsDialog).getByRole('button', { name: 'Company & access' }));

    await user.click(await within(settingsDialog).findByRole('button', { name: 'Rename agents to world era' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Rename agents for this world era?' });
    expect(within(confirmDialog).getByText('Pharaoh Khufu')).toBeInTheDocument();
    expect(within(confirmDialog).getByText('Imhotep')).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole('button', { name: 'Yes, rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename agents for this world era?' })).not.toBeInTheDocument());
    expect(calls.find(c => c.path === '/api/world/rename-agents')).toEqual({
      method: 'POST',
      path: '/api/world/rename-agents',
      body: { lang: 'en', confirmed: true },
    });
    expect(within(settingsDialog).getByRole('status')).toHaveTextContent('Renamed 2 agents.');

    await user.click(within(settingsDialog).getByRole('button', { name: 'Restore original names' }));
    const restoreDialog = await screen.findByRole('dialog', { name: 'Restore original agent names?' });
    await user.click(within(restoreDialog).getByRole('button', { name: 'Yes, restore' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restore original agent names?' })).not.toBeInTheDocument());
    expect(calls.find(c => c.path === '/api/world/restore-names')).toEqual({
      method: 'POST',
      path: '/api/world/restore-names',
      body: { confirmed: true },
    });
    expect(within(settingsDialog).getByRole('status')).toHaveTextContent('Restored 2 original names.');
  });

  it('shows a simple human-friendly chat popup for a clicked agent without terminal tool noise and sends real messages', async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      'GET /api/agents/b1/events?last=40': [
        200,
        {
          events: [
            { seq: 1, kind: 'message', data: { text: 'Please check the harbor build.' }, jobId: null, person: { id: 'p1', name: 'Ivan' }, at: '2026-11-22T02:00:00.000Z' },
            { seq: 2, kind: 'tool', data: { name: 'run_command', input: { cmd: 'npm test' } }, jobId: null, person: null, at: '2026-11-22T02:00:01.000Z' },
            { seq: 3, kind: 'tool_result', data: { output: 'PASS' }, jobId: null, person: null, at: '2026-11-22T02:00:02.000Z' },
            { seq: 4, kind: 'text', data: { text: 'Yes, my lord, the harbor build is complete.' }, jobId: null, person: null, at: '2026-11-22T02:00:03.000Z' },
          ],
          state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 },
        },
      ],
      'POST /api/agents/b1/messages': [201, { ok: true }],
    });

    render(
      <LanguageProvider>
        <WorldAgentQuickChat agentId="b1" agentName="Imhotep" />
      </LanguageProvider>,
    );

    expect(await screen.findByText('Please check the harbor build.')).toBeInTheDocument();
    expect(screen.getByText('Yes, my lord, the harbor build is complete.')).toBeInTheDocument();
    expect(screen.queryByText(/run_command|npm test/)).not.toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: 'Message Imhotep' });
    await user.type(input, 'Start the next stage please');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(calls.find(c => c.method === 'POST' && c.path === '/api/agents/b1/messages')).toEqual({
        method: 'POST',
        path: '/api/agents/b1/messages',
        body: { text: 'Start the next stage please' },
      }),
    );
    expect(screen.getByText('Start the next stage please')).toBeInTheDocument();
  });
});
